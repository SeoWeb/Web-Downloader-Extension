"""Share service gRPC servicer implementation."""

import base64
import os
import secrets
from datetime import datetime, timezone

import grpc
from sqlalchemy import select, update

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import share_pb2
import share_pb2_grpc
from db import db_session, get_engine
from models import ShareLink


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _dt_from_ts(ts):
    """Parse a unix timestamp into a naive-UTC datetime."""
    return datetime.fromtimestamp(ts, tz=timezone.utc).replace(tzinfo=None)


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
                return share_pb2.ShareLinkResponse(
                    token=existing.token,
                    short_url=f"{self.base_url}/s/{existing.token}",
                    is_public=existing.is_public,
                    expires_at=int(existing.expires_at.timestamp()) if existing.expires_at else 0,
                    view_count=existing.view_count,
                    page_id=existing.page_id,
                    user_id=existing.user_id,
                    created_at=existing.created_at.isoformat(),
                    revoked_at=existing.revoked_at.isoformat() if existing.revoked_at else "",
                )

            link = ShareLink(
                token=token,
                user_id=request.user_id,
                page_id=request.page_id,
                is_public=request.is_public,
                expires_at=expires_at,
            )
            session.add(link)
            session.flush()

            return share_pb2.ShareLinkResponse(
                token=link.token,
                short_url=f"{self.base_url}/s/{link.token}",
                is_public=link.is_public,
                expires_at=int(link.expires_at.timestamp()) if link.expires_at else 0,
                view_count=0,
                page_id=link.page_id,
                user_id=link.user_id,
                created_at=link.created_at.isoformat(),
                revoked_at="",
            )

    def GetShareLink(self, request, context):
        with db_session(self.engine) as session:
            link = session.execute(
                select(ShareLink).where(ShareLink.token == request.token)
            ).scalar_one_or_none()

            if not link:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Share link not found")
                return share_pb2.ShareLinkResponse()

            return share_pb2.ShareLinkResponse(
                token=link.token,
                short_url=f"{self.base_url}/s/{link.token}",
                is_public=link.is_public,
                expires_at=int(link.expires_at.timestamp()) if link.expires_at else 0,
                view_count=link.view_count,
                page_id=link.page_id,
                user_id=link.user_id,
                created_at=link.created_at.isoformat(),
                revoked_at=link.revoked_at.isoformat() if link.revoked_at else "",
            )

    def RevokeShareLink(self, request, context):
        with db_session(self.engine) as session:
            link = session.execute(
                select(ShareLink).where(ShareLink.token == request.token)
            ).scalar_one_or_none()

            if not link or link.user_id != request.user_id:
                return share_pb2.StatusResponse(success=False, message="not found")

            link.revoked_at = _utcnow()

        return share_pb2.StatusResponse(success=True)

    def ValidateToken(self, request, context):
        with db_session(self.engine) as session:
            link = session.execute(
                select(ShareLink).where(ShareLink.token == request.token)
            ).scalar_one_or_none()

            if not link:
                return share_pb2.ValidateShareResponse(valid=False)

            if link.revoked_at is not None:
                return share_pb2.ValidateShareResponse(valid=False)

            if not link.is_public:
                return share_pb2.ValidateShareResponse(valid=False)

            if link.expires_at and link.expires_at < _utcnow():
                return share_pb2.ValidateShareResponse(valid=False)

            # Atomic view count increment (SQL-level to prevent lost updates)
            session.execute(
                update(ShareLink)
                .where(ShareLink.token == request.token)
                .values(view_count=ShareLink.view_count + 1)
            )

            return share_pb2.ValidateShareResponse(valid=True, page_id=link.page_id)
