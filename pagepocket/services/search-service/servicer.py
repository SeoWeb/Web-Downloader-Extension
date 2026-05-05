"""Search service gRPC servicer implementation."""

import os

import grpc
from sqlalchemy import select, func, text, delete

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import search_pb2
import search_pb2_grpc
from db import db_session, get_engine
from models import PageIndex

MEDIUMTEXT_LIMIT = 16 * 1024 * 1024  # 16 MB

MATCH_FTS = "MATCH(title, body_text) AGAINST(:query IN NATURAL LANGUAGE MODE)"


class SearchServicer(search_pb2_grpc.SearchServiceServicer):
    def __init__(self):
        self.engine = get_engine()

    def IndexPage(self, request, context):
        body_text = (request.body_text or "")[:MEDIUMTEXT_LIMIT]

        with db_session(self.engine) as session:
            existing = session.execute(
                select(PageIndex).where(PageIndex.page_id == request.page_id)
            ).scalar_one_or_none()

            if existing:
                existing.url = request.url
                existing.title = request.title
                existing.body_text = body_text
                existing.user_id = request.user_id
                if request.tags:
                    existing.tags = request.tags
            else:
                entry = PageIndex(
                    page_id=request.page_id,
                    user_id=request.user_id,
                    url=request.url,
                    title=request.title,
                    body_text=body_text,
                    tags=request.tags or None,
                )
                session.add(entry)

        return search_pb2.StatusResponse(success=True)

    def RemovePage(self, request, context):
        with db_session(self.engine) as session:
            session.execute(
                delete(PageIndex).where(
                    PageIndex.page_id == request.page_id,
                    PageIndex.user_id == request.user_id,
                )
            )
        return search_pb2.StatusResponse(success=True)

    def Search(self, request, context):
        query_str = request.query.strip()
        if not query_str:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("Query must not be empty")
            return search_pb2.SearchResponse()

        page_num = max(request.page, 1)
        page_size = max(min(request.page_size or 20, 100), 1)
        offset = (page_num - 1) * page_size
        params = {"query": query_str, "uid": request.user_id}

        coll_filter = ""
        if request.collection_id:
            coll_filter = (
                "AND page_index.page_id IN "
                "(SELECT page_id FROM library_db.page_collections "
                "WHERE collection_id = :coll_id)"
            )
            params["coll_id"] = request.collection_id

        with db_session(self.engine) as session:
            # Count
            count_sql = text(f"""
                SELECT COUNT(*) FROM page_index
                WHERE user_id = :uid AND {MATCH_FTS} {coll_filter}
            """)
            total = session.execute(count_sql, params).scalar()

            # Fetch results
            results_sql = text(f"""
                SELECT page_id, url, title, body_text, archived_at,
                       {MATCH_FTS} AS score
                FROM page_index
                WHERE user_id = :uid AND {MATCH_FTS} {coll_filter}
                ORDER BY score DESC
                LIMIT :lim OFFSET :off
            """)
            params["lim"] = page_size
            params["off"] = offset
            rows = session.execute(results_sql, params).fetchall()

            search_results = []
            for row in rows:
                body = row.body_text or ""
                snippet = _make_snippet(body, query_str, max_len=240)
                search_results.append(search_pb2.SearchResult(
                    page_id=row.page_id,
                    url=row.url,
                    title=row.title,
                    snippet=snippet,
                    score=float(row.score),
                    archived_at=row.archived_at.isoformat(),
                ))

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
