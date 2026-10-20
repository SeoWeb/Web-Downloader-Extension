"""Archive service gRPC servicer implementation."""

import json
import logging
import os
import posixpath
import re
import shutil
import sys
import tempfile
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime

import grpc
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import archive_pb2
import archive_pb2_grpc
import common_pb2
import library_pb2
import library_pb2_grpc
import search_pb2
import search_pb2_grpc
import share_pb2
import share_pb2_grpc
from cache import cache_delete, cache_get, cache_invalidate_pattern, cache_set
from cache_config import (
    TTL_MEDIUM,
    TTL_SHORT,
    key_page,
    key_pages_list,
    pattern_pages,
)
from db import db_session, get_engine
from grpc_pool import get_stub
from models import Page, UserQuota
from page_processor import sanitise_and_rewrite
from quota import confirm_quota, refund_quota, reserve_quota
from r2_client import R2Client
from text_utils import truncate_utf8

logger = logging.getLogger(__name__)

# Search-index delivery retry budget at ingest time (3.8). Failures beyond
# this leave the row's search_indexed=False for RetryPendingIndexing.
_INDEX_RETRY_BACKOFF_SECONDS = (0.5, 2.0)

# Explicit deadline for EVERY outbound service-to-service call (2.9): a wedged
# upstream must fail with DEADLINE_EXCEEDED instead of freezing a worker.
_RPC_TIMEOUT_SECONDS = 30.0

# MEDIUMTEXT byte limit with headroom (2.5/D7) — truncation is byte-safe via
# shared text_utils.truncate_utf8, never a character slice.
_SEARCH_BODY_LIMIT_BYTES = 16 * 1024 * 1024 - 4096

# extension_job_id guard (2.1, defense in depth — the gateway validates too):
# 1-36 characters of UUID/address-safe charset, matching the String(36) column.
_EXTENSION_JOB_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,36}$")

# Orphan sweep defaults (5.9).
_ORPHAN_GRACE_PERIOD_SECONDS = 7 * 24 * 3600
_ORPHAN_SCAN_BATCH = 500

# Page ZIP export (add-page-export-zip, D3): the ZIP is assembled into a
# SpooledTemporaryFile that spills to disk past the RAM threshold, then
# streamed back in chunks well under gRPC's 4 MB default message cap.
_EXPORT_SPOOL_MAX_BYTES = 64 * 1024 * 1024
_EXPORT_CHUNK_BYTES = 512 * 1024
_EXPORT_ZIP_COMPRESS_LEVEL = 6  # DEFLATE level 6 (matches monolith zip_assembler)


def _classify_r2_error(exc: Exception) -> grpc.StatusCode:
    """Classify an R2/S3 exception into a gRPC status (2.13, design note f).

    Missing-object errors (NoSuchKey / 404) map to NOT_FOUND, so the gateway's
    assets/ fallback fires only for genuine 404s. Overload/throttling
    (SlowDown / 503 / ServiceUnavailable) maps to UNAVAILABLE so clients get
    the 503 + Retry-After path instead of "file not found" during rate-limit
    storms. Everything else is INTERNAL.
    """
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        error_code = str(response.get("Error", {}).get("Code", "")).lower()
        http_status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if error_code in ("nosuchkey", "404", "notfound") or http_status == 404:
            return grpc.StatusCode.NOT_FOUND
        if error_code in ("slowdown", "serviceunavailable", "503", "503 slow down") or (
            isinstance(http_status, int) and http_status == 503
        ):
            return grpc.StatusCode.UNAVAILABLE

    blob = f"{type(exc).__name__} {exc}".lower()
    if "nosuchkey" in blob or "not found" in blob or "404" in blob:
        return grpc.StatusCode.NOT_FOUND
    if (
        "slowdown" in blob
        or "503" in blob
        or "serviceunavailable" in blob
        or "service unavailable" in blob
    ):
        return grpc.StatusCode.UNAVAILABLE
    return grpc.StatusCode.INTERNAL


def _normalize_archive_rel_path(file_path: str) -> str | None:
    """Normalize a page-relative archive path; None when it must be rejected.

    Security (2.8): the path is normalized and anything that escapes the
    page's archive root is invalid — any '..' segment or an absolute path,
    regardless of the object store's flat namespace. A leading '../' slips
    past a naive substring check, hence the segment check. Shared by
    GetArchiveFile (request validation) and ExportPage (every object read /
    ZIP entry name).
    """
    if not file_path:
        return None
    normalized = posixpath.normpath(file_path)
    segments = normalized.split("/")
    if (
        normalized.startswith("/")
        or file_path.startswith("/")
        or normalized == ".."
        or any(seg == ".." for seg in segments)
    ):
        return None
    return normalized


def _get_search_stub():
    addr = os.environ.get("SEARCH_SERVICE_ADDR")
    if not addr:
        return None
    # Memoized channel+stub (2.10/D7) — no per-call channel teardown.
    return get_stub(addr, search_pb2_grpc.SearchServiceStub)


def _get_library_stub():
    addr = os.environ.get("LIBRARY_SERVICE_ADDR")
    if not addr:
        return None
    return get_stub(addr, library_pb2_grpc.LibraryServiceStub)


def _get_share_stub():
    addr = os.environ.get("SHARE_SERVICE_ADDR")
    if not addr:
        return None
    return get_stub(addr, share_pb2_grpc.ShareServiceStub)


def _page_to_dict(p):
    # r2_key deliberately omitted (5.1): the storage key is internal and no
    # longer part of the PageResponse contract (field 6 reserved).
    return {
        "id": p.id,
        "user_id": p.user_id,
        "url": p.url,
        "title": p.title,
        "preview_text": p.preview_text or "",
        "size_bytes": p.size_bytes,
        "extension_job_id": p.extension_job_id or "",
        "archived_at": p.archived_at.isoformat(),
    }


def _dict_to_page_response(d):
    # Filter to the message's real fields: cache entries written before the
    # r2_key removal (5.1) still carry the key and must degrade gracefully
    # instead of raising on an unknown keyword.
    fields = archive_pb2.PageResponse.DESCRIPTOR.fields_by_name
    return archive_pb2.PageResponse(**{k: v for k, v in d.items() if k in fields})


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
            # Byte-safe truncation (2.5/D7): a character slice overflows the
            # MEDIUMTEXT byte limit for CJK text and can split a multi-byte
            # sequence ("Data too long" → permanent preview-only index).
            body_text=truncate_utf8(body_text, _SEARCH_BODY_LIMIT_BYTES),
        )
        for attempt in range(len(_INDEX_RETRY_BACKOFF_SECONDS) + 1):
            try:
                stub.IndexPage(req, timeout=_RPC_TIMEOUT_SECONDS)
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

    def _release_reservation(self, user_id: str, request_size: int) -> None:
        """Best-effort release of a quota reservation (2.14). Never raises."""
        try:
            with db_session(self.engine) as session:
                refund_quota(session, user_id, request_size)
        except Exception as exc:
            logger.error(
                "Failed to release quota reservation for user %s (%d bytes): %s",
                user_id, request_size, exc,
            )

    def _handle_ingest_race(
        self, exc, *, user_id, extension_job_id, prefix, request_size
    ):
        """Lost the (user_id, extension_job_id) unique-index race (2.1/D5).

        A concurrent ingest of the same job committed its page row first, so
        this attempt's insert failed at flush/commit. Roll back, re-select the
        winner, release this attempt's now-dead reservation, clean up its
        just-uploaded R2 prefix, and return an idempotent success carrying the
        winner's page_id — never gRPC UNKNOWN/HTTP 500, never a duplicate row.
        """
        winner_id = None
        if extension_job_id:
            with db_session(self.engine) as session:
                row = session.execute(
                    select(Page).where(
                        Page.extension_job_id == extension_job_id,
                        Page.user_id == user_id,
                    )
                ).scalar_one_or_none()
                if row is not None:
                    winner_id = row.id  # read before the session closes

        # This attempt is dead either way: release its reservation and clean
        # up its uploaded prefix (both best-effort, sweep-eligible on failure).
        self._release_reservation(user_id, request_size)
        self._cleanup_failed_ingest(prefix)

        if winner_id is None:
            raise exc  # not the idempotency race — surface the real error

        cache_invalidate_pattern(pattern_pages(user_id))
        logger.info(
            "Ingest race for job %s (user %s): converged on existing page %s",
            extension_job_id, user_id, winner_id,
        )
        return archive_pb2.IngestPageResponse(success=True, page_id=winner_id)

    def IngestPage(self, request, context):
        user_id = request.user_id
        extension_job_id = request.extension_job_id
        plan = request.plan or "free"  # deprecated-but-honored (5.2)

        # Service-side guard (2.1, defense in depth — the gateway also
        # validates): a malformed job id must be INVALID_ARGUMENT, never a
        # column-overflow 500.
        if extension_job_id and not _EXTENSION_JOB_ID_RE.fullmatch(extension_job_id):
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details(
                "extension_job_id must be 1-36 characters of [A-Za-z0-9._:-]"
            )
            return archive_pb2.IngestPageResponse()

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

        # Quota reserve in a SHORT transaction (2.14): replay check + check
        # and increment of both counters, committed immediately — the FOR
        # UPDATE lock is released before any R2 upload, so overlapping ingests
        # never hit the 50 s lock-wait timeout (design note e).
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

            error = reserve_quota(session, user_id, plan, total_size)
            if error:
                context.set_code(grpc.StatusCode.RESOURCE_EXHAUSTED)
                context.set_details(error)
                return archive_pb2.IngestPageResponse()

        # Sanitise and rewrite HTML
        rewritten_html, preview_text, body_text = sanitise_and_rewrite(
            request.html_content, asset_map
        )

        # Upload to R2 (parallel for throughput) — lock-free: the quota row
        # lock was released with the reserve transaction (2.14).
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
                "archived_at": datetime.now(UTC).isoformat(),
                "size_bytes": total_size,
            })
            self.r2.upload(f"{prefix}/meta.json", meta.encode(), "application/json")
        except Exception:
            # Failed ingest after partial R2 upload (2.14): release the
            # reservation first, then best-effort delete everything this
            # attempt uploaded. The exception keeps propagating so the caller
            # sees the original failure.
            self._release_reservation(user_id, total_size)
            self._cleanup_failed_ingest(prefix)
            raise

        # Confirm the reservation + insert the page row (2.14): re-check the
        # limits under the lock — concurrent ingests may have consumed the
        # budget while this one uploaded — then commit authoritatively.
        # search_indexed=False is the durable pending index record (3.8).
        over_quota_error = None
        try:
            with db_session(self.engine) as session:
                error = confirm_quota(session, user_id, plan, total_size)
                if error:
                    # The reservation was already refunded inside
                    # confirm_quota; the uploaded R2 objects are cleaned up
                    # below before answering.
                    over_quota_error = error
                else:
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
        except IntegrityError as exc:
            return self._handle_ingest_race(
                exc,
                user_id=user_id,
                extension_job_id=extension_job_id,
                prefix=prefix,
                request_size=total_size,
            )

        if over_quota_error:
            self._cleanup_failed_ingest(prefix)
            context.set_code(grpc.StatusCode.RESOURCE_EXHAUSTED)
            context.set_details(over_quota_error)
            return archive_pb2.IngestPageResponse()

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

        # If collection_id is set, resolve page IDs from library service.
        # Outage semantics (2.11/D8): a FILTERED listing that cannot be
        # resolved fails with UNAVAILABLE (gateway → 503 + Retry-After). It
        # never degrades to an empty set — that would hide the user's pages
        # AND write a poisoned empty result into the cache — and the log
        # always states the true cause (library unavailability).
        if request.collection_id:
            stub = _get_library_stub()
            resp = None
            if stub is not None:
                try:
                    resp = stub.ListCollectionPageIds(
                        library_pb2.ListCollectionPageIdsRequest(
                            collection_id=request.collection_id,
                            user_id=request.user_id,
                        ),
                        timeout=_RPC_TIMEOUT_SECONDS,
                    )
                except grpc.RpcError as exc:
                    logger.warning(
                        "Collection filter unavailable: ListCollectionPageIds failed "
                        "for collection %s (user %s): %s",
                        request.collection_id, request.user_id, exc,
                    )
            else:
                logger.warning(
                    "Collection filter unavailable: LIBRARY_SERVICE_ADDR is not "
                    "configured, so collection %s (user %s) cannot be resolved",
                    request.collection_id, request.user_id,
                )
            if resp is None:
                context.set_code(grpc.StatusCode.UNAVAILABLE)
                context.set_details("Collection filter temporarily unavailable")
                return archive_pb2.ListPagesResponse()
            collection_page_ids = set(resp.page_ids)

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

        # Presigned URLs removed (D4/5.1): this RPC no longer mints or returns
        # an R2 presigned GET URL (the signed_url field's tag is reserved).
        # Archived content is delivered exclusively via the sandboxed
        # asset-serving path; ownership validation remains the gate here.
        return archive_pb2.PageContentResponse()

    def GetArchiveFile(self, request, context):
        file_path = request.file_path

        # Mandatory ownership (2.3): an empty user_id is a hard error, never
        # a wildcard. Share flows resolve the owner at ValidateToken.
        if not request.user_id:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("user_id is required")
            return archive_pb2.ArchiveFileResponse()

        # Security (2.8): normalize the path and reject anything that escapes
        # the page's archive root (see _normalize_archive_rel_path).
        normalized = _normalize_archive_rel_path(file_path)
        if normalized is None:
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
        except Exception as exc:
            # Classified mapping (2.13/design note f): only genuine
            # missing-object errors are NOT_FOUND (so the gateway's assets/
            # fallback fires solely for real 404s); storage overload is
            # UNAVAILABLE (503 + Retry-After), never "file not found".
            code = _classify_r2_error(exc)
            context.set_code(code)
            context.set_details(
                "File not found" if code == grpc.StatusCode.NOT_FOUND else "Storage error"
            )
            return archive_pb2.ArchiveFileResponse()

    def ExportPage(self, request, context):
        """Stream one archived page as a zip64 ZIP (add-page-export-zip, D1–D3).

        All R2 work (prefix listing, object reads, spool assembly) happens
        BEFORE the first chunk is yielded, so listing/read failures classify
        into a clean gRPC status instead of killing a half-sent stream. The
        spool keeps service RAM flat — only one object is decompressed-in/
        compressed-out at a time, and past 64 MB the ZIP itself lives on pod
        disk; the returned generator merely slices the spool.
        """
        # Mandatory ownership (2.3): an empty user_id is a hard error, never
        # a wildcard (same contract as GetArchiveFile).
        if not request.user_id:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("user_id is required")
            return iter(())

        with db_session(self.engine) as session:
            page = session.execute(
                select(Page).where(Page.id == request.page_id)
            ).scalar_one_or_none()

            # Identical answer for missing and foreign pages — no existence
            # leak (Export Authorization spec scenario).
            if not page or page.user_id != request.user_id:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Page not found")
                return iter(())

            # Read before the session closes (commit would expire instances).
            user_id = page.user_id
            page_id = page.id

        page_prefix = f"{user_id}/{page_id}/"

        # D2: the R2 prefix listing is the source of truth — works for every
        # existing page with no asset manifest and no backfill. The thumbnail
        # ({user_id}/{page_id}.webp) sits OUTSIDE the prefix and is excluded
        # naturally.
        try:
            listed_keys: list[str] = []
            paginator = self.r2.client.get_paginator("list_objects_v2")
            for listed in paginator.paginate(Bucket=self.r2.bucket, Prefix=page_prefix):
                listed_keys.extend(obj["Key"] for obj in listed.get("Contents", []))
        except Exception as exc:
            code = _classify_r2_error(exc)
            logger.error("ExportPage: R2 listing failed for %s: %s", page_prefix, exc)
            context.set_code(code)
            context.set_details("Storage error")
            return iter(())

        # Zip entries must be safe relative paths: a listed key that cannot be
        # represented as one (e.g. contains '..') is skipped — never shipped in
        # a downloadable artifact (zip-slip guard), logged for visibility.
        entries: list[tuple[str, str]] = []  # (zip-relative name, R2 key)
        for key in listed_keys:
            rel = key[len(page_prefix):]
            if not rel or _normalize_archive_rel_path(rel) != rel:
                logger.warning("ExportPage: skipping unsafe object key %s", key)
                continue
            entries.append((rel, key))

        # D3 deterministic order: index.html, meta.json, then assets sorted by
        # key; any other object sorts after assets. Stable archives, happy tests.
        def _entry_order(item: tuple[str, str]) -> tuple[int, str]:
            rel = item[0]
            if rel == "index.html":
                return (0, rel)
            if rel == "meta.json":
                return (1, rel)
            if rel.startswith("assets/"):
                return (2, rel)
            return (3, rel)

        entries.sort(key=_entry_order)

        # SIM115: the spool's lifetime intentionally spans the streaming
        # generator returned below; it is closed in that generator's finally.
        spool = tempfile.SpooledTemporaryFile(  # noqa: SIM115
            max_size=_EXPORT_SPOOL_MAX_BYTES,
            mode="w+b",
            prefix="pagepocket-export-",
        )
        key = ""  # bound for the failure log before the first loop iteration
        try:
            with zipfile.ZipFile(
                spool,
                "w",
                compression=zipfile.ZIP_DEFLATED,
                compresslevel=_EXPORT_ZIP_COMPRESS_LEVEL,
                allowZip64=True,  # D3: zip64 — per-page archives can outgrow 32-bit bounds
            ) as zf:
                for _rel, key in entries:
                    # Path hardening reuse: entry names came from the normalized
                    # listing above; reads target the listed key verbatim.
                    response = self.r2.client.get_object(Bucket=self.r2.bucket, Key=key)
                    body = response["Body"]
                    try:
                        with zf.open(_rel, "w") as entry:
                            # Stream the object through in bounded pieces — the
                            # whole archive is never held in RAM (spec scenario).
                            shutil.copyfileobj(body, entry, length=_EXPORT_CHUNK_BYTES)
                    finally:
                        body.close()
        except Exception as exc:
            spool.close()
            # Classified mapping (2.13/design note f): R2 read/listing causes
            # surface as NOT_FOUND/UNAVAILABLE, everything else (zip assembly
            # itself) as INTERNAL — and all of it BEFORE the first chunk is
            # yielded, never a half-streamed "success".
            code = _classify_r2_error(exc)
            logger.error(
                "ExportPage: export of %s/%s failed (while reading %s): %s",
                user_id, page_id, key, exc,
            )
            context.set_code(code)
            context.set_details("Storage error")
            return iter(())

        spool.seek(0)

        def _chunks():
            try:
                while True:
                    data = spool.read(_EXPORT_CHUNK_BYTES)
                    if not data:
                        return
                    yield archive_pb2.ExportPageChunk(data=data)
            finally:
                spool.close()

        return _chunks()

    def DeletePage(self, request, context):
        # Tombstone-then-delete (2.2/D6): commit the row deletion + quota
        # decrement FIRST. A crash before the R2 deletions then leaves a
        # consistent state — the page is gone from the user's view (no
        # zombie) and the leftover objects are plain sweepable orphans. The
        # old order (R2 deletes inside the open transaction) could crash into
        # an unrecoverable zombie page whose objects were already gone.
        with db_session(self.engine) as session:
            page = session.execute(
                select(Page).where(Page.id == request.page_id)
            ).scalar_one_or_none()

            if not page or page.user_id != request.user_id:
                return common_pb2.StatusResponse(success=False, message="not found")

            size = page.size_bytes
            user_id = page.user_id
            session.delete(page)

            # Decrement quota in the SAME committed transaction
            quota = session.execute(
                select(UserQuota).where(UserQuota.user_id == request.user_id).with_for_update()
            ).scalar_one_or_none()
            if quota:
                quota.total_bytes = max(0, quota.total_bytes - size)

        cache_delete(key_page(request.page_id))
        cache_invalidate_pattern(pattern_pages(user_id))

        # Deletion is durable — now remove the R2 objects. Failures leave
        # sweepable orphans, not zombies; logged, never fatal.
        prefix = f"{user_id}/{request.page_id}"
        try:
            self.r2.delete_prefix(prefix)
        except Exception as exc:
            logger.error(
                "DeletePage: R2 prefix deletion failed for %s "
                "(left as sweepable orphan): %s", prefix, exc,
            )

        # Thumbnail (best-effort — a missing/failing thumbnail must not fail
        # the delete; a failure is visible in the logs).
        try:
            self.r2.delete(f"{user_id}/{request.page_id}.webp")
        except Exception as exc:
            logger.warning(
                "Could not delete thumbnail %s/%s.webp during page delete: %s",
                user_id, request.page_id, exc,
            )

        # Downstream cleanup (2.4): search removal + share-link revocation +
        # library link purge. Best-effort with explicit deadlines — each
        # failure only leaves bounded, loggable drift.
        self._notify_removal(request.page_id, request.user_id)

        return common_pb2.StatusResponse(success=True)

    def _notify_removal(self, page_id: str, user_id: str) -> None:
        """Best-effort downstream cleanup after a committed page delete (2.4).

        Every call carries an explicit deadline; a failure is logged and
        never fails the delete.
        """
        search_stub = _get_search_stub()
        if search_stub:
            try:
                search_stub.RemovePage(
                    search_pb2.RemovePageRequest(page_id=page_id, user_id=user_id),
                    timeout=_RPC_TIMEOUT_SECONDS,
                )
            except Exception as exc:
                logger.warning(
                    "RemovePage failed for page %s (user %s): %s "
                    "— search index may hold a stale entry",
                    page_id, user_id, exc,
                )

        share_stub = _get_share_stub()
        if share_stub:
            try:
                share_stub.RevokeLinksForPage(
                    share_pb2.RevokeLinksForPageRequest(page_id=page_id),
                    timeout=_RPC_TIMEOUT_SECONDS,
                )
            except Exception as exc:
                logger.warning(
                    "RevokeLinksForPage failed for page %s (user %s): %s "
                    "— share links may dangle",
                    page_id, user_id, exc,
                )

        library_stub = _get_library_stub()
        if library_stub:
            try:
                library_stub.PurgePageLinks(
                    library_pb2.PurgePageLinksRequest(page_id=page_id),
                    timeout=_RPC_TIMEOUT_SECONDS,
                )
            except Exception as exc:
                logger.warning(
                    "PurgePageLinks failed for page %s (user %s): %s "
                    "— collection counts may drift",
                    page_id, user_id, exc,
                )

    # ------------------------------------------------------------------
    # Maintenance RPCs (internal only — not proxied by the gateway)
    # ------------------------------------------------------------------

    def _load_page_html(self, user_id: str, page_id: str) -> bytes | None:
        """Fetch the page's authoritative index.html from R2 (2.6/D7)."""
        try:
            response = self.r2.client.get_object(
                Bucket=self.r2.bucket, Key=f"{user_id}/{page_id}/index.html"
            )
            return response["Body"].read()
        except Exception as exc:
            logger.warning(
                "Could not read %s/%s/index.html from R2: %s", user_id, page_id, exc,
            )
            return None

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
                # Re-read the authoritative HTML from R2 (2.6/D7): the
                # 500-char preview_text is not the page — re-indexing it
                # would permanently bake a truncated entry into the index.
                html = self._load_page_html(page.user_id, page.id)
                if html is None:
                    logger.warning(
                        "RetryPendingIndexing: index.html missing in R2 for page %s "
                        "— page purged or storage unavailable; left pending",
                        page.id,
                    )
                    continue
                try:
                    _rewritten, _preview, body_text = sanitise_and_rewrite(html, {})
                except Exception as exc:
                    logger.warning(
                        "RetryPendingIndexing: body re-extraction failed for page %s: %s "
                        "— left pending", page.id, exc,
                    )
                    continue
                ok = self._index_page_with_retry(
                    stub,
                    page_id=page.id,
                    user_id=page.user_id,
                    url=page.url,
                    title=page.title,
                    body_text=body_text,
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
                ts_dt = ts_dt.replace(tzinfo=UTC)
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
