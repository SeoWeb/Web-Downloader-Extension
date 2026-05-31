"""Archive service gRPC servicer implementation."""

import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import time

import grpc
from sqlalchemy import select, func

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import archive_pb2
import archive_pb2_grpc
import search_pb2
import search_pb2_grpc
import library_pb2
import library_pb2_grpc
from db import db_session, get_engine
from grpc_mtls import secure_channel_credentials
from models import Page, UserQuota
from page_processor import sanitise_and_rewrite
from quota import check_and_reserve
from r2_client import R2Client
from cache import cache_get, cache_set, cache_delete, cache_invalidate_pattern
from cache_config import (
    TTL_MEDIUM, TTL_SHORT,
    key_page, key_pages_list,
    pattern_pages,
)


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

    def IngestPage(self, request, context):
        user_id = request.user_id
        extension_job_id = request.extension_job_id

        with db_session(self.engine) as session:
            # Idempotency check
            if extension_job_id:
                existing = session.execute(
                    select(Page).where(Page.extension_job_id == extension_job_id)
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

            # Insert page row
            page = Page(
                id=page_id,
                user_id=user_id,
                url=request.url,
                title=title,
                preview_text=preview_text,
                r2_key=r2_key,
                size_bytes=total_size,
                extension_job_id=extension_job_id or None,
            )
            session.add(page)

            # Increment quota
            quota = session.execute(
                select(UserQuota).where(UserQuota.user_id == user_id).with_for_update()
            ).scalar_one_or_none()
            if quota:
                quota.pages_this_month += 1
                quota.total_bytes += total_size

        # Fire-and-forget search indexing
        try:
            stub = _get_search_stub()
            if stub:
                stub.IndexPage(search_pb2.IndexPageRequest(
                    page_id=page_id,
                    user_id=user_id,
                    url=request.url,
                    title=title,
                    body_text=body_text[:16 * 1024 * 1024],  # MEDIUMTEXT limit
                ))
        except Exception:
            pass  # Fire-and-forget

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
                except grpc.RpcError:
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
        with db_session(self.engine) as session:
            page = session.execute(
                select(Page).where(Page.id == request.page_id)
            ).scalar_one_or_none()

            if not page or (request.user_id and page.user_id != request.user_id):
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

        # Security: prevent path traversal
        if "/.." in file_path or file_path.startswith("/"):
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("Invalid file path")
            return archive_pb2.ArchiveFileResponse()

        with db_session(self.engine) as session:
            page = session.execute(
                select(Page).where(Page.id == request.page_id)
            ).scalar_one_or_none()

            if not page or (request.user_id and page.user_id != request.user_id):
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Page not found")
                return archive_pb2.ArchiveFileResponse()

            user_id = page.user_id
            page_id = page.id

        r2_key = f"{user_id}/{page_id}/{file_path}"

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

            # Delete thumbnail
            try:
                self.r2.delete(f"{page.user_id}/{page.id}.webp")
            except Exception:
                pass

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

        # Fire-and-forget search removal
        try:
            stub = _get_search_stub()
            if stub:
                stub.RemovePage(search_pb2.RemovePageRequest(
                    page_id=request.page_id,
                    user_id=request.user_id,
                ))
        except Exception:
            pass

        return archive_pb2.StatusResponse(success=True)
