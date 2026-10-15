"""Archive service gRPC servicer implementation."""

import json
import logging
import os
import posixpath
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import grpc
from sqlalchemy import func, select

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import archive_pb2
import archive_pb2_grpc
import library_pb2
import library_pb2_grpc
import search_pb2
import search_pb2_grpc
from cache import cache_delete, cache_get, cache_invalidate_pattern, cache_set
from cache_config import (
    TTL_MEDIUM,
    TTL_SHORT,
    key_page,
    key_pages_list,
    pattern_pages,
)
from db import db_session, get_engine
from grpc_mtls import secure_channel_credentials
from models import Page, UserQuota
from page_processor import sanitise_and_rewrite
from quota import check_and_reserve
from r2_client import R2Client

logger = logging.getLogger(__name__)

# Search-index delivery retry budget at ingest time (3.8). Failures beyond
# this leave the row's search_indexed=False for RetryPendingIndexing.
_INDEX_RETRY_BACKOFF_SECONDS = (0.5, 2.0)

# Orphan sweep defaults (5.9).
_ORPHAN_GRACE_PERIOD_SECONDS = 7 * 24 * 3600
_ORPHAN_SCAN_BATCH = 500


def _get_search_stub():
    addr = os.environ.get("SEARCH_SERVICE_ADDR")
    if not addr:
        return None
    mtls = os.environ.get("MTLS_ENABLED", "false").lower() == "true"
    if mtls:
        channel = grpc.secure_channel(addr, secure_channel_credentials())
    else:
        channel = grpc.insecure_channel(addr)
    return search_pb2_grpc.SearchServiceStub(channel)


def _get_library_stub():
    addr = os.environ.get("LIBRARY_SERVICE_ADDR")
    if not addr:
        return None
    mtls = os.environ.get("MTLS_ENABLED", "false").lower() == "true"
    if mtls:
        channel = grpc.secure_channel(addr, secure_channel_credentials())
    else:
        channel = grpc.insecure_channel(addr)
    return library_pb2_grpc.LibraryServiceStub(channel)


def _page_to_dict(p):
    return {
        "id": p.id,
        "user_id": p.user_id,
        "url": p.url,
        "title": p.title,
        "preview_text": p.preview_text or "",
        "r2_key": p.r2_key,
        "size_bytes": p.size_bytes,
        "extension_job_id": p.extension_job_id or "",
        "archived_at": p.archived_at.isoformat(),
    }


def _dict_to_page_response(d):
    return archive_pb2.PageResponse(**d)


class ArchiveServicer(archive_pb2_grpc.ArchiveServiceServicer):
    def __init__(self):
        self.engine = get_engine()
        self.r2 = R2Client()

    def _index_page_with_retry(self, stub, *, page_id, user_id, url, title, body_text):
        """Deliver one page to the search service with bounded retries.

        Returns True once IndexPage succeeds. Backoff sleeps between attempts;
        the final failure is logged loudly and reflected by the caller (the
        row's durable search_indexed=False pending flag).
        """
        req = search_pb2.IndexPageRequest(
            page_id=page_id,
            user_id=user_id,
            url=url,
            title=title,
            body_text=body_text[:16 * 1024 * 1024],  # MEDIUMTEXT limit
        )
        for attempt in range(len(_INDEX_RETRY_BACKOFF_SECONDS) + 1):
            try:
                stub.IndexPage(req)
                return True
            except grpc.RpcError as exc:
                if attempt < len(_INDEX_RETRY_BACKOFF_SECONDS):
                    logger.warning(
                        "IndexPage attempt %d failed for page %s: %s — retrying",
                        attempt + 1, page_id, exc,
                    )
                    time.sleep(_INDEX_RETRY_BACKOFF_SECONDS[attempt])
                else:
                    logger.error(
                        "IndexPage failed permanently for page %s after %d attempts: %s "
                        "(pending re-index via RetryPendingIndexing)",
                        page_id, attempt + 1, exc,
                    )
            except Exception as exc:  # transport-level errors must not kill ingest
                logger.error(
                    "IndexPage raised for page %s: %s (pending re-index via RetryPendingIndexing)",
                    page_id, exc,
                )
                return False
        return False

    def _cleanup_failed_ingest(self, prefix: str) -> None:
        """Best-effort R2 cleanup for a failed ingest attempt (2.9).

        Never raises: cleanup failure is logged with the orphaned prefix and
        the prefix stays eligible for SweepOrphanR2Objects.
        """
        try:
            self.r2.delete_prefix(prefix)
            logger.info("Cleaned up R2 prefix %s after failed ingest", prefix)
        except Exception as exc:
            logger.error(
                "Failed to clean up R2 prefix %s after failed ingest "
                "(eligible for orphan sweep): %s", prefix, exc,
            )

    def IngestPage(self, request, context):
        user_id = request.user_id
        extension_job_id = request.extension_job_id

        with db_session(self.engine) as session:
            # Idempotency check — scoped to THIS user (2.6): the same job id
            # from a different user is a brand-new ingest, never a replay.
            if extension_job_id:
                existing = session.execute(
                    select(Page).where(
                        Page.extension_job_id == extension_job_id,
                        Page.user_id == user_id,
                    )
                ).scalar_one_or_none()
                if existing:
                    return archive_pb2.IngestPageResponse(success=True, page_id=existing.id)

            # Determine title
            title = request.title
            if not title:
                from bs4 import BeautifulSoup
                soup = BeautifulSoup(request.html_content, "lxml")
                t = soup.find("title")
                title = t.string.strip() if t and t.string else request.url

            # Build asset map and calculate size
            page_id = str(uuid.uuid4())
            asset_map = {}
            total_size = len(request.html_content)

            for asset in request.assets:
                asset_map[asset.filename] = f"assets/{asset.filename}"
                total_size += len(asset.data)

            # Quota check
            error = check_and_reserve(session, user_id, request.plan or "free", total_size)
            if error:
                context.set_code(grpc.StatusCode.RESOURCE_EXHAUSTED)
                context.set_details(error)
                return archive_pb2.IngestPageResponse()

            # Sanitise and rewrite HTML
            rewritten_html, preview_text, body_text = sanitise_and_rewrite(
                request.html_content, asset_map
            )

            # Upload to R2 (parallel for throughput)
            prefix = f"{user_id}/{page_id}"
            try:
                upload_errors = []

                def _upload_asset(asset):
                    try:
                        self.r2.upload(
                            f"{prefix}/assets/{asset.filename}",
                            asset.data,
                            asset.content_type or "application/octet-stream",
                        )
                    except Exception as exc:
                        return f"{asset.filename}: {exc}"
                    return None

                with ThreadPoolExecutor(max_workers=8) as pool:
                    futures = {pool.submit(_upload_asset, a): a for a in request.assets}
                    for future in as_completed(futures):
                        err = future.result()
                        if err:
                            upload_errors.append(err)

                if upload_errors:
                    raise RuntimeError(f"R2 upload failures: {'; '.join(upload_errors)}")

                r2_key = f"{prefix}/index.html"
                self.r2.upload(r2_key, rewritten_html, "text/html; charset=utf-8")

                # Upload meta.json
                meta = json.dumps({
                    "title": title,
                    "url": request.url,
                    "archived_at": datetime.now(timezone.utc).isoformat(),
                    "size_bytes": total_size,
                })
                self.r2.upload(f"{prefix}/meta.json", meta.encode(), "application/json")

                # Insert page row — search_indexed=False is the durable pending
                # index record, committed with the page (3.8).
                page = Page(
                    id=page_id,
                    user_id=user_id,
                    url=request.url,
                    title=title,
                    preview_text=preview_text,
                    r2_key=r2_key,
                    size_bytes=total_size,
                    extension_job_id=extension_job_id or None,
                    search_indexed=False,
                )
                session.add(page)

                # Increment quota
                quota = session.execute(
                    select(UserQuota).where(UserQuota.user_id == user_id).with_for_update()
                ).scalar_one_or_none()
                if quota:
                    quota.pages_this_month += 1
                    quota.total_bytes += total_size
            except Exception:
                # Failed ingest after partial R2 upload (2.9): release DB row
                # locks / roll back quota increments first, then best-effort
                # delete everything this attempt uploaded. The exception keeps
                # propagating so the caller sees the original failure.
                session.rollback()
                self._cleanup_failed_ingest(prefix)
                raise

        # Reliable search indexing (3.8): attempt delivery now with bounded
        # retries; on failure the committed search_indexed=False row is
        # retried later via RetryPendingIndexing — never silently dropped.
        search_stub = _get_search_stub()
        if search_stub:
            indexed = self._index_page_with_retry(
                search_stub,
                page_id=page_id,
                user_id=user_id,
                url=request.url,
                title=title,
                body_text=body_text,
            )
            if indexed:
                try:
                    with db_session(self.engine) as session:
                        page_row = session.execute(
                            select(Page).where(Page.id == page_id)
                        ).scalar_one_or_none()
                        if page_row is not None and not page_row.search_indexed:
                            page_row.search_indexed = True
                except Exception:
                    logger.warning(
                        "Could not mark page %s as indexed; RetryPendingIndexing will re-index it",
                        page_id,
                    )

        cache_invalidate_pattern(pattern_pages(user_id))

        return archive_pb2.IngestPageResponse(success=True, page_id=page_id)

    def GetPage(self, request, context):
        ck = key_page(request.page_id)
        cached = cache_get(ck)
        if cached and cached.get("user_id") == request.user_id:
            return _dict_to_page_response(cached)

        with db_session(self.engine) as session:
            page = session.execute(
                select(Page).where(Page.id == request.page_id)
            ).scalar_one_or_none()

            if not page or page.user_id != request.user_id:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Page not found")
                return archive_pb2.PageResponse()

            data = _page_to_dict(page)
            cache_set(ck, data, TTL_MEDIUM)
            return _dict_to_page_response(data)

    def ListPages(self, request, context):
        sort_by = request.sort_by or "archived_at"
        page_num = max(request.page, 1)
        page_size = max(min(request.page_size or 20, 100), 1)
        offset = (page_num - 1) * page_size

        collection_page_ids = None
        coll_id = request.collection_id or ""

        # If collection_id is set, resolve page IDs from library service
        if request.collection_id:
            stub = _get_library_stub()
            if stub:
                try:
                    resp = stub.ListCollectionPageIds(library_pb2.ListCollectionPageIdsRequest(
                        collection_id=request.collection_id,
                        user_id=request.user_id,
                    ))
                    collection_page_ids = set(resp.page_ids)
                except grpc.RpcError as exc:
                    # Library unavailable → the collection filter degrades to
                    # "no pages"; never silently — say so in the logs.
                    logger.warning(
                        "ListCollectionPageIds failed for collection %s (user %s): %s "
                        "— listing without the collection filter",
                        request.collection_id, request.user_id, exc,
                    )
                    collection_page_ids = set()
            else:
                collection_page_ids = set()

        ck = key_pages_list(request.user_id, page_num, page_size, sort_by, coll_id)
        cached = cache_get(ck)
        if cached is not None:
            return archive_pb2.ListPagesResponse(
                pages=[_dict_to_page_response(p) for p in cached["pages"]],
                total=cached["total"],
            )

        with db_session(self.engine) as session:
            query = select(Page).where(Page.user_id == request.user_id)
            count_q = select(func.count()).select_from(Page).where(Page.user_id == request.user_id)

            if collection_page_ids is not None:
                query = query.where(Page.id.in_(collection_page_ids))
                count_q = count_q.where(Page.id.in_(collection_page_ids))

            if sort_by == "title":
                query = query.order_by(Page.title.asc())
            else:
                query = query.order_by(Page.archived_at.desc())

            total = session.execute(count_q).scalar()
            rows = session.execute(query.offset(offset).limit(page_size)).scalars().all()

            pages = [_page_to_dict(p) for p in rows]
            cache_set(ck, {"pages": pages, "total": total}, TTL_SHORT)

            return archive_pb2.ListPagesResponse(
                pages=[_dict_to_page_response(p) for p in pages],
                total=total,
            )

    def GetPageContent(self, request, context):
        # Mandatory ownership (2.3): an empty user_id is a hard error, never
        # a wildcard. Share flows resolve the owner at ValidateToken and pass
        # it explicitly.
        if not request.user_id:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("user_id is required")
            return archive_pb2.PageContentResponse()

        with db_session(self.engine) as session:
            page = session.execute(
                select(Page).where(Page.id == request.page_id)
            ).scalar_one_or_none()

            if not page or page.user_id != request.user_id:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Page not found")
                return archive_pb2.PageContentResponse()

            r2_key = page.r2_key

        url = self.r2.presign(r2_key, expires=3600)
        return archive_pb2.PageContentResponse(
            signed_url=url,
            expires_at=int(time.time()) + 3600,
        )

    def GetArchiveFile(self, request, context):
        file_path = request.file_path

        # Mandatory ownership (2.3): an empty user_id is a hard error, never
        # a wildcard. Share flows resolve the owner at ValidateToken.
        if not request.user_id:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("user_id is required")
            return archive_pb2.ArchiveFileResponse()

        # Security (2.8): normalize the path and reject anything that escapes
        # the page's archive root — any '..' segment or an absolute path is
        # invalid regardless of the object store's flat namespace. A leading
        # '../' slips past a naive substring check, hence the segment check.
        normalized = posixpath.normpath(file_path)
        segments = normalized.split("/")
        if (
            not file_path
            or normalized.startswith("/")
            or file_path.startswith("/")
            or normalized == ".."
            or any(seg == ".." for seg in segments)
        ):
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("Invalid file path")
            return archive_pb2.ArchiveFileResponse()

        with db_session(self.engine) as session:
            page = session.execute(
                select(Page).where(Page.id == request.page_id)
            ).scalar_one_or_none()

            if not page or page.user_id != request.user_id:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Page not found")
                return archive_pb2.ArchiveFileResponse()

            user_id = page.user_id
            page_id = page.id

        r2_key = f"{user_id}/{page_id}/{normalized}"

        try:
            response = self.r2.client.get_object(Bucket=self.r2.bucket, Key=r2_key)
            data = response["Body"].read()
            content_type = response.get("ContentType", "application/octet-stream")
            return archive_pb2.ArchiveFileResponse(data=data, content_type=content_type)
        except Exception:
            context.set_code(grpc.StatusCode.NOT_FOUND)
            context.set_details("File not found")
            return archive_pb2.ArchiveFileResponse()

    def DeletePage(self, request, context):
        with db_session(self.engine) as session:
            page = session.execute(
                select(Page).where(Page.id == request.page_id)
            ).scalar_one_or_none()

            if not page or page.user_id != request.user_id:
                return archive_pb2.StatusResponse(success=False, message="not found")

            # Delete R2 prefix
            prefix = f"{page.user_id}/{page.id}"
            self.r2.delete_prefix(prefix)

            # Delete thumbnail (best-effort — a missing thumbnail must not
            # fail the delete; a failure is at least visible in the logs).
            try:
                self.r2.delete(f"{page.user_id}/{page.id}.webp")
            except Exception as exc:
                logger.warning(
                    "Could not delete thumbnail %s/%s.webp during page delete: %s",
                    page.user_id, page.id, exc,
                )

            size = page.size_bytes
            user_id = page.user_id
            session.delete(page)

            # Decrement quota
            quota = session.execute(
                select(UserQuota).where(UserQuota.user_id == request.user_id).with_for_update()
            ).scalar_one_or_none()
            if quota:
                quota.total_bytes = max(0, quota.total_bytes - size)

        cache_delete(key_page(request.page_id))
        cache_invalidate_pattern(pattern_pages(user_id))

        # Fire-and-forget search removal — the page row is already gone, so a
        # failure here only leaves a stale index entry; log it loudly so the
        # drift is observable and re-deletable via search-service tooling.
        try:
            stub = _get_search_stub()
            if stub:
                stub.RemovePage(search_pb2.RemovePageRequest(
                    page_id=request.page_id,
                    user_id=request.user_id,
                ))
        except Exception as exc:
            logger.warning(
                "Fire-and-forget RemovePage failed for page %s (user %s): %s "
                "— search index may hold a stale entry",
                request.page_id, request.user_id, exc,
            )

        return archive_pb2.StatusResponse(success=True)

    # ------------------------------------------------------------------
    # Maintenance RPCs (internal only — not proxied by the gateway)
    # ------------------------------------------------------------------

    def RetryPendingIndexing(self, request, context):
        """Re-deliver pages whose search indexing previously failed (3.8).

        Intended to be scheduled periodically by ops (cron/grpcurl against
        the internal service network). Returns counts for observability.
        """
        limit = request.limit or 100
        retried = 0
        succeeded = 0

        stub = _get_search_stub()
        if stub is None:
            logger.warning("RetryPendingIndexing: SEARCH_SERVICE_ADDR not configured")
            return archive_pb2.RetryPendingIndexingResponse(retried=0, succeeded=0)

        with db_session(self.engine) as session:
            pending = session.execute(
                select(Page)
                .where(Page.search_indexed.is_(False))
                .order_by(Page.archived_at.asc())
                .limit(limit)
            ).scalars().all()

            for page in pending:
                retried += 1
                # The full body text is not persisted; preview_text (the
                # indexed search surface) is the best available payload.
                ok = self._index_page_with_retry(
                    stub,
                    page_id=page.id,
                    user_id=page.user_id,
                    url=page.url,
                    title=page.title,
                    body_text=page.preview_text or "",
                )
                if ok:
                    page.search_indexed = True
                    succeeded += 1

        if retried:
            logger.info(
                "RetryPendingIndexing: retried %d pending pages, %d succeeded",
                retried, succeeded,
            )
        return archive_pb2.RetryPendingIndexingResponse(
            retried=retried, succeeded=succeeded,
        )

    def SweepOrphanR2Objects(self, request, context):
        """Delete R2 objects whose page row is gone, older than a grace period (5.9).

        Scans `{user_id}/{page_id}/` prefixes and `{user_id}/{page_id}.webp`
        thumbnails against archive_db.pages. Objects younger than the grace
        period (default 7 days) are never touched — that covers in-flight
        ingests, which upload to R2 before inserting the row. Quota counters
        are NOT modified: orphans were never counted.
        """
        grace = request.grace_period_seconds or _ORPHAN_GRACE_PERIOD_SECONDS
        cutoff_ts = time.time() - grace
        scanned = 0
        deleted_prefixes = 0
        deleted_objects = 0
        errors: list[str] = []

        def _epoch(ts_dt: datetime) -> float:
            # boto3 returns tz-aware UTC; treat naive values as UTC so
            # .timestamp() never misinterprets them as local time.
            if ts_dt.tzinfo is None:
                ts_dt = ts_dt.replace(tzinfo=timezone.utc)
            return ts_dt.timestamp()

        def _uuid_or_none(value: str):
            try:
                return str(uuid.UUID(value))
            except (ValueError, AttributeError):
                return None

        try:
            paginator = self.r2.client.get_paginator("list_objects_v2")
            user_prefixes = []
            for page in paginator.paginate(
                Bucket=self.r2.bucket, Delimiter="/", PaginationConfig={"PageSize": _ORPHAN_SCAN_BATCH}
            ):
                user_prefixes.extend(p.get("Prefix", "") for p in page.get("CommonPrefixes", []))
            if request.max_prefixes > 0:
                user_prefixes = user_prefixes[: request.max_prefixes]
        except Exception as exc:
            logger.error("Orphan sweep: failed to list user prefixes: %s", exc)
            return archive_pb2.SweepOrphanR2ObjectsResponse(errors=[f"list user prefixes: {exc}"])

        for user_prefix in user_prefixes:
            scanned += 1
            page_prefixes: list[str] = []   # candidate {user}/{page}/ prefixes
            thumbnails: list[str] = []      # candidate {user}/{page}.webp keys
            try:
                for page in paginator.paginate(
                    Bucket=self.r2.bucket,
                    Prefix=user_prefix,
                    Delimiter="/",
                    PaginationConfig={"PageSize": _ORPHAN_SCAN_BATCH},
                ):
                    page_prefixes.extend(p.get("Prefix", "") for p in page.get("CommonPrefixes", []))
                    thumbnails.extend(
                        obj["Key"] for obj in page.get("Contents", [])
                        if obj["Key"].endswith(".webp")
                    )
            except Exception as exc:
                errors.append(f"list {user_prefix}: {exc}")
                continue

            # Collect candidate page ids with their object keys/ages.
            candidates: dict[str, list[dict]] = {}
            for prefix in page_prefixes:
                page_id = _uuid_or_none(prefix.rstrip("/").rsplit("/", 1)[-1])
                if page_id is None:
                    continue  # not a page prefix — never touch
                candidates.setdefault(page_id, []).append({"prefix": prefix, "keys": []})

            for key in thumbnails:
                stem = key.rsplit("/", 1)[-1][: -len(".webp")]
                page_id = _uuid_or_none(stem)
                if page_id is None:
                    continue
                candidates.setdefault(page_id, []).append({"prefix": None, "keys": [key]})

            if not candidates:
                continue

            with db_session(self.engine) as session:
                existing_ids = set(
                    session.execute(
                        select(Page.id).where(Page.id.in_(list(candidates)))
                    ).scalars().all()
                )

            for page_id, locations in candidates.items():
                if page_id in existing_ids:
                    continue  # row exists — live page, never swept here

                keys: list[str] = []
                prefix_to_delete = None
                newest_ts = 0.0
                try:
                    for loc in locations:
                        if loc["prefix"]:
                            prefix_to_delete = loc["prefix"]
                            for page in paginator.paginate(
                                Bucket=self.r2.bucket, Prefix=loc["prefix"],
                                PaginationConfig={"PageSize": _ORPHAN_SCAN_BATCH},
                            ):
                                for obj in page.get("Contents", []):
                                    keys.append(obj["Key"])
                                    newest_ts = max(newest_ts, _epoch(obj["LastModified"]))
                        else:
                            keys.extend(loc["keys"])
                            for page in paginator.paginate(
                                Bucket=self.r2.bucket, Prefix=loc["keys"][0],
                                PaginationConfig={"PageSize": _ORPHAN_SCAN_BATCH},
                            ):
                                for obj in page.get("Contents", []):
                                    newest_ts = max(newest_ts, _epoch(obj["LastModified"]))

                    if not keys or newest_ts >= cutoff_ts:
                        continue  # in-flight or nothing to delete — leave in place

                    # Quota-neutral by design: orphaned objects were never
                    # counted against any user's quota.
                    self.r2.client.delete_objects(
                        Bucket=self.r2.bucket,
                        Delete={"Objects": [{"Key": k} for k in keys]},
                    )
                    deleted_objects += len(keys)
                    if prefix_to_delete:
                        deleted_prefixes += 1
                    logger.info(
                        "Orphan sweep: deleted %d objects under %s (no pages row, older than grace)",
                        len(keys), prefix_to_delete or keys[0],
                    )
                except Exception as exc:
                    errors.append(f"sweep {page_id}: {exc}")
                    logger.error("Orphan sweep: failed for page %s: %s", page_id, exc)

        logger.info(
            "Orphan sweep summary: scanned=%d user prefixes, deleted=%d prefixes / %d objects, errors=%d",
            scanned, deleted_prefixes, deleted_objects, len(errors),
        )
        return archive_pb2.SweepOrphanR2ObjectsResponse(
            scanned_prefixes=scanned,
            deleted_prefixes=deleted_prefixes,
            deleted_objects=deleted_objects,
            errors=errors,
        )
