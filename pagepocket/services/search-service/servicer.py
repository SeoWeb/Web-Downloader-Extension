"""Search service gRPC servicer implementation."""

import logging
import os
import sys
from datetime import datetime

import grpc
from sqlalchemy import bindparam, delete, select, text
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import common_pb2
import library_pb2
import library_pb2_grpc
import search_pb2
import search_pb2_grpc
from cache import cache_get, cache_invalidate_pattern, cache_set
from cache_config import TTL_LONG, key_search, pattern_search
from db import db_session, get_engine
from grpc_pool import get_stub
from models import PageIndex
from text_utils import truncate_utf8

logger = logging.getLogger(__name__)

MEDIUMTEXT_LIMIT = 16 * 1024 * 1024  # 16 MB — MySQL MEDIUMTEXT byte ceiling
TRUNCATE_SAFETY_MARGIN = 4096

# D7: service-to-service RPCs get explicit deadlines (30 s class).
LIBRARY_RPC_TIMEOUT_SECONDS = 30

MATCH_FTS = "MATCH(title, body_text) AGAINST(:query IN NATURAL LANGUAGE MODE)"
LIKE_FILTER = "(title LIKE :like_q OR body_text LIKE :like_q)"


def _get_library_stub():
    """Memoized library-service client via the shared gRPC pool (2.10).

    Returns None when LIBRARY_SERVICE_ADDR is not configured; collection
    filtering then fails closed (UNAVAILABLE) rather than silently ignoring
    the filter, which would leak results across collection boundaries.
    """
    addr = os.environ.get("LIBRARY_SERVICE_ADDR")
    if not addr:
        return None
    return get_stub(addr, library_pb2_grpc.LibraryServiceStub)


def _upsert_page_index(session, *, page_id, user_id, url, title, body_text, tags):
    """Atomically upsert one page_index row (2.7).

    A single statement per dialect — no read-then-insert window, so two
    concurrent IndexPage calls for the same page_id both succeed (one insert,
    one duplicate-key update) and neither can fail with an IntegrityError:

    - MySQL (production): INSERT … ON DUPLICATE KEY UPDATE.
    - SQLite (tests/dev): the dialect-native INSERT … ON CONFLICT DO UPDATE.

    Both overwrite title/url/body_text/user_id, leave archived_at untouched,
    and only overwrite tags when the new request carries one.
    """
    values = {
        "page_id": page_id,
        "user_id": user_id,
        "url": url,
        "title": title,
        "body_text": body_text,
        "tags": tags,
    }
    update_values = {
        "url": url,
        "title": title,
        "body_text": body_text,
        "user_id": user_id,
    }
    if tags:
        update_values["tags"] = tags

    dialect = session.bind.dialect.name
    if dialect == "mysql":
        stmt = mysql_insert(PageIndex).values(**values)
        stmt = stmt.on_duplicate_key_update(**update_values)
    elif dialect == "sqlite":
        stmt = sqlite_insert(PageIndex).values(**values)
        stmt = stmt.on_conflict_do_update(
            index_elements=[PageIndex.page_id], set_=update_values
        )
    else:  # pragma: no cover — defensive: keep legacy behavior on other dialects
        existing = session.execute(
            select(PageIndex).where(PageIndex.page_id == page_id)
        ).scalar_one_or_none()
        if existing:
            existing.url = url
            existing.title = title
            existing.body_text = body_text
            existing.user_id = user_id
            if tags:
                existing.tags = tags
            return
        session.add(PageIndex(**values))
        return

    session.execute(stmt)


def _isoformat_ts(value) -> str:
    """ISO-format a DATETIME that may arrive as datetime (MySQL) or as an
    ISO string (SQLite raw-SQL rows keep their stored text form)."""
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


class SearchServicer(search_pb2_grpc.SearchServiceServicer):
    def __init__(self):
        self.engine = get_engine()

    def IndexPage(self, request, context):
        # D7: byte-safe truncation via the shared helper — slicing by
        # character count let multi-byte (CJK) bodies exceed the MySQL
        # MEDIUMTEXT byte limit and fail the insert permanently.
        body_text = truncate_utf8(
            request.body_text or "", MEDIUMTEXT_LIMIT - TRUNCATE_SAFETY_MARGIN
        )

        with db_session(self.engine) as session:
            _upsert_page_index(
                session,
                page_id=request.page_id,
                user_id=request.user_id,
                url=request.url,
                title=request.title,
                body_text=body_text,
                tags=request.tags or None,
            )

        cache_invalidate_pattern(pattern_search(request.user_id))
        return common_pb2.StatusResponse(success=True)

    def RemovePage(self, request, context):
        with db_session(self.engine) as session:
            session.execute(
                delete(PageIndex).where(
                    PageIndex.page_id == request.page_id,
                    PageIndex.user_id == request.user_id,
                )
            )
        cache_invalidate_pattern(pattern_search(request.user_id))
        return common_pb2.StatusResponse(success=True)

    def _collection_page_ids(self, request, context):
        """Resolve a collection filter via the library RPC (2.8 / D12).

        Replaces the embedded cross-schema ``page_collections`` subquery: the
        search service never issues SQL against another service's schema.

        Returns the page-id set for an owned collection, an empty set for an
        empty collection or one not visible to this user (the library RPC
        scopes by user_id, so NOT_FOUND simply yields no ids), or None when
        the library service failed — in which case context is set to
        UNAVAILABLE. A library outage must fail loudly, never silently
        degrade into an unfiltered search.
        """
        stub = _get_library_stub()
        if stub is None:
            context.set_code(grpc.StatusCode.UNAVAILABLE)
            context.set_details("Collection filter temporarily unavailable")
            return None
        try:
            resp = stub.ListCollectionPageIds(
                library_pb2.ListCollectionPageIdsRequest(
                    collection_id=request.collection_id,
                    user_id=request.user_id,
                ),
                timeout=LIBRARY_RPC_TIMEOUT_SECONDS,
            )
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.NOT_FOUND:
                # Owned RPC said "not yours / does not exist": authoritative
                # empty id set, no existence leak via search.
                return set()
            logger.warning(
                "ListCollectionPageIds failed for user %s collection %s: %s",
                request.user_id, request.collection_id, exc.code(),
            )
            context.set_code(grpc.StatusCode.UNAVAILABLE)
            context.set_details("Collection filter temporarily unavailable")
            return None
        return set(resp.page_ids)

    def Search(self, request, context):
        query_str = request.query.strip()
        if not query_str:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("Query must not be empty")
            return search_pb2.SearchResponse()

        page_num = max(request.page, 1)
        page_size = max(min(request.page_size or 20, 100), 1)
        offset = (page_num - 1) * page_size
        coll_id = request.collection_id or ""

        ck = key_search(request.user_id, query_str, page_num, page_size, coll_id)
        cached = cache_get(ck)
        if cached is not None:
            results = [
                search_pb2.SearchResult(**r) for r in cached["results"]
            ]
            return search_pb2.SearchResponse(results=results, total=cached["total"])

        params = {"query": query_str, "uid": request.user_id, "like_q": f"%{query_str}%"}

        coll_filter = ""
        if request.collection_id:
            coll_ids = self._collection_page_ids(request, context)
            if coll_ids is None:
                # Library failure already mapped to UNAVAILABLE — never cache.
                return search_pb2.SearchResponse()
            if not coll_ids:
                # Empty collection: the id list came from an owned library RPC
                # call, so empty is an authoritative, cacheable result.
                cache_set(ck, {"results": [], "total": 0}, TTL_LONG)
                return search_pb2.SearchResponse(results=[], total=0)
            coll_filter = "AND page_index.page_id IN :coll_ids"
            params["coll_ids"] = tuple(sorted(coll_ids))

        with db_session(self.engine) as session:
            score_expr = f"{MATCH_FTS}"
            base_where = f"user_id = :uid AND {LIKE_FILTER} {coll_filter}"

            # Expanding bind param only binds when the placeholder exists.
            def _compiled(sql):
                return text(sql).bindparams(bindparam("coll_ids", expanding=True))

            # Count
            count_sql = _compiled(f"""
                SELECT COUNT(*) FROM page_index
                WHERE {base_where}
            """)
            total = session.execute(count_sql, params).scalar()

            # Fetch results
            results_sql = _compiled(f"""
                SELECT page_id, url, title, body_text, archived_at,
                       {score_expr} AS score
                FROM page_index
                WHERE {base_where}
                ORDER BY score DESC
                LIMIT :lim OFFSET :off
            """)
            params["lim"] = page_size
            params["off"] = offset
            rows = session.execute(results_sql, params).fetchall()

            search_results = []
            serializable_results = []
            for row in rows:
                body = row.body_text or ""
                snippet = _make_snippet(body, query_str, max_len=240)
                archived_at = _isoformat_ts(row.archived_at)
                result = search_pb2.SearchResult(
                    page_id=row.page_id,
                    url=row.url,
                    title=row.title,
                    snippet=snippet,
                    score=float(row.score),
                    archived_at=archived_at,
                )
                search_results.append(result)
                serializable_results.append({
                    "page_id": row.page_id,
                    "url": row.url,
                    "title": row.title,
                    "snippet": snippet,
                    "score": float(row.score),
                    "archived_at": archived_at,
                })

            cache_set(ck, {"results": serializable_results, "total": total}, TTL_LONG)
            return search_pb2.SearchResponse(results=search_results, total=total)


def _make_snippet(body: str, query: str, max_len: int = 240) -> str:
    """Extract a snippet around the first match, never exceeding max_len."""
    lower_body = body.lower()
    lower_query = query.lower()
    idx = lower_body.find(lower_query)
    if idx == -1:
        return body[:max_len]

    ellipsis = "..."
    budget = max_len - len(ellipsis) * 2  # reserve space for both markers
    start = max(0, idx - budget // 2)
    end = min(len(body), start + budget)
    snippet = body[start:end]
    if start > 0:
        snippet = ellipsis + snippet
    if end < len(body):
        snippet = snippet + ellipsis
    return snippet[:max_len]
