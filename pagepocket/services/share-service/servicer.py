"""Share service gRPC servicer implementation."""

import os
import secrets
import sys
from datetime import datetime, timezone

import grpc
from sqlalchemy import select, update

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import share_pb2
import share_pb2_grpc
from cache import cache_delete, cache_get, cache_set
from cache_config import TTL_SHARE_LINK, key_share_page, key_share_token
from db import db_session, get_engine
from models import ShareLink


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _dt_from_ts(ts):
    """Parse a unix timestamp into a naive-UTC datetime."""
    return datetime.fromtimestamp(ts, tz=timezone.utc).replace(tzinfo=None)


def _link_to_dict(link, base_url):
    return {
        "token": link.token,
        "short_url": f"{base_url}/s/{link.token}",
        "is_public": link.is_public,
        "expires_at": int(link.expires_at.timestamp()) if link.expires_at else 0,
        "view_count": link.view_count,
        "page_id": link.page_id,
        "user_id": link.user_id,
        "created_at": link.created_at.isoformat(),
        "revoked_at": link.revoked_at.isoformat() if link.revoked_at else "",
    }


def _dict_to_link_response(d):
    return share_pb2.ShareLinkResponse(**d)


class ShareServicer(share_pb2_grpc.ShareServiceServicer):
    def __init__(self):
        self.engine = get_engine()
        self.base_url = os.environ.get("BASE_URL", "http://localhost:8000")

    def CreateShareLink(self, request, context):
        token = secrets.token_urlsafe(32)
        if len(token) > 64:
            token = token[:64]

        expires_at = None
        if request.expires_at:
            expires_at = _dt_from_ts(request.expires_at)

        with db_session(self.engine) as session:
            # Check for existing active link
            existing = session.execute(
                select(ShareLink).where(
                    ShareLink.user_id == request.user_id,
                    ShareLink.page_id == request.page_id,
                    ShareLink.revoked_at.is_(None),
                )
            ).scalar_one_or_none()

            if existing and (not existing.expires_at or existing.expires_at > _utcnow()):
                data = _link_to_dict(existing, self.base_url)
                cache_set(key_share_token(existing.token), data, TTL_SHARE_LINK)
                cache_set(key_share_page(request.user_id, request.page_id), data, TTL_SHARE_LINK)
                return _dict_to_link_response(data)

            link = ShareLink(
                token=token,
                user_id=request.user_id,
                page_id=request.page_id,
                is_public=request.is_public,
                expires_at=expires_at,
            )
            session.add(link)
            session.flush()

            data = _link_to_dict(link, self.base_url)
            cache_set(key_share_token(link.token), data, TTL_SHARE_LINK)
            cache_set(key_share_page(request.user_id, request.page_id), data, TTL_SHARE_LINK)

            return _dict_to_link_response(data)

    def _link_to_response(self, link):
        return _dict_to_link_response(_link_to_dict(link, self.base_url))

    def GetShareLink(self, request, context):
        ck = key_share_token(request.token)
        cached = cache_get(ck)
        if cached is not None:
            if cached.get("revoked_at"):
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Share link not found")
                return share_pb2.ShareLinkResponse()
            return _dict_to_link_response(cached)

        with db_session(self.engine) as session:
            link = session.execute(
                select(ShareLink).where(ShareLink.token == request.token)
            ).scalar_one_or_none()

            if not link:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Share link not found")
                return share_pb2.ShareLinkResponse()

            data = _link_to_dict(link, self.base_url)
            cache_set(ck, data, TTL_SHARE_LINK)
            return _dict_to_link_response(data)

    def GetShareLinkByPage(self, request, context):
        ck = key_share_page(request.user_id, request.page_id)
        cached = cache_get(ck)
        if cached is not None:
            if cached.get("revoked_at"):
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("No active share link for this page")
                return share_pb2.ShareLinkResponse()
            return _dict_to_link_response(cached)

        with db_session(self.engine) as session:
            link = session.execute(
                select(ShareLink).where(
                    ShareLink.user_id == request.user_id,
                    ShareLink.page_id == request.page_id,
                    ShareLink.revoked_at.is_(None),
                ).order_by(ShareLink.created_at.desc())
            ).scalar_one_or_none()

            if not link:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("No active share link for this page")
                return share_pb2.ShareLinkResponse()

            data = _link_to_dict(link, self.base_url)
            cache_set(ck, data, TTL_SHARE_LINK)
            cache_set(key_share_token(link.token), data, TTL_SHARE_LINK)
            return _dict_to_link_response(data)

    def RevokeShareLink(self, request, context):
        with db_session(self.engine) as session:
            link = session.execute(
                select(ShareLink).where(ShareLink.token == request.token)
            ).scalar_one_or_none()

            if not link or link.user_id != request.user_id:
                return share_pb2.StatusResponse(success=False, message="not found")

            link.revoked_at = _utcnow()
            page_owner = link.user_id
            page_id = link.page_id

        cache_delete(key_share_token(request.token))
        cache_delete(key_share_page(page_owner, page_id))
        return share_pb2.StatusResponse(success=True)

    def ValidateToken(self, request, context):
        ck = key_share_token(request.token)
        cached = cache_get(ck)
        if cached is not None:
            if cached.get("revoked_at") or not cached.get("is_public"):
                return share_pb2.ValidateShareResponse(valid=False)
            if cached.get("expires_at") and cached["expires_at"] < int(_utcnow().timestamp()):
                cache_delete(ck)
                return share_pb2.ValidateShareResponse(valid=False)
            # Still valid — but we need to increment view count in DB
            with db_session(self.engine) as session:
                session.execute(
                    update(ShareLink)
                    .where(ShareLink.token == request.token)
                    .values(view_count=ShareLink.view_count + 1)
                )
            return share_pb2.ValidateShareResponse(valid=True, page_id=cached["page_id"])

        with db_session(self.engine) as session:
            link = session.execute(
                select(ShareLink).where(ShareLink.token == request.token)
            ).scalar_one_or_none()

            if not link:
                return share_pb2.ValidateShareResponse(valid=False)

            if link.revoked_at is not None:
                cache_set(ck, _link_to_dict(link, self.base_url), TTL_SHARE_LINK)
                return share_pb2.ValidateShareResponse(valid=False)

            if not link.is_public:
                cache_set(ck, _link_to_dict(link, self.base_url), TTL_SHARE_LINK)
                return share_pb2.ValidateShareResponse(valid=False)

            if link.expires_at and link.expires_at < _utcnow():
                cache_set(ck, _link_to_dict(link, self.base_url), TTL_SHARE_LINK)
                return share_pb2.ValidateShareResponse(valid=False)

            # Atomic view count increment (SQL-level to prevent lost updates)
            session.execute(
                update(ShareLink)
                .where(ShareLink.token == request.token)
                .values(view_count=ShareLink.view_count + 1)
            )

            data = _link_to_dict(link, self.base_url)
            cache_set(ck, data, TTL_SHARE_LINK)

            return share_pb2.ValidateShareResponse(valid=True, page_id=link.page_id)
