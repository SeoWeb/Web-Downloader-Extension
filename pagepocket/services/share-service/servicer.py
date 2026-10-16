"""Share service gRPC servicer implementation."""

import hashlib
import logging
import os
import secrets
import sys
from datetime import UTC, datetime

import grpc
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import archive_pb2
import archive_pb2_grpc
import common_pb2
import share_pb2
import share_pb2_grpc
from cache import cache_delete, cache_get, cache_incr, cache_set
from cache_config import (
    TTL_SHARE_LINK,
    TTL_SHARE_VALID,
    TTL_VIEW_DEDUPE,
    key_share_page,
    key_share_token,
    key_share_view,
)
from db import db_session, get_engine
from grpc_pool import get_stub
from models import ShareLink

logger = logging.getLogger(__name__)


def _get_archive_stub():
    """Memoized archive-service client via the shared gRPC pool (2.10).

    Optional archive-service client for defense-in-depth ownership checks:
    the gateway resolves page ownership before CreateShareLink (primary
    enforcement); when ARCHIVE_SERVICE_ADDR is configured, this service
    additionally verifies ownership itself so a caller that bypasses the
    gateway cannot mint links to pages it does not own. Channels are
    memoized in the shared pool instead of being opened per call.
    """
    addr = os.environ.get("ARCHIVE_SERVICE_ADDR")
    if not addr:
        return None
    return get_stub(addr, archive_pb2_grpc.ArchiveServiceStub)


def _utcnow():
    return datetime.now(UTC).replace(tzinfo=None)


def _dt_from_ts(ts):
    """Parse a unix timestamp into a naive-UTC datetime."""
    return datetime.fromtimestamp(ts, tz=UTC).replace(tzinfo=None)


def _hash_token(token: str) -> str:
    """SHA-256 of the URL-safe token — the only value persisted (2.15a)."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _is_expired(link, now=None) -> bool:
    """True when the link carries an expires_at in the past.

    Accepts a ShareLink row (datetime column) or a cached dict (epoch seconds).
    """
    if isinstance(link, dict):
        ts = link.get("expires_at") or 0
        return bool(ts and ts < _ts(now or _utcnow()))
    return bool(link.expires_at and link.expires_at < (now or _utcnow()))


_EPOCH = datetime(1970, 1, 1)


def _ts(dt: datetime) -> int:
    """Unix epoch for a naive-UTC datetime.

    ``datetime.timestamp()`` interprets naive datetimes as LOCAL time; the
    service stores naive UTC (see _utcnow/_dt_from_ts), so a non-UTC server
    timezone would shift every reported expires_at/created_at by the offset.
    """
    return int((dt - _EPOCH).total_seconds())


def _link_to_dict(link, base_url, token=None):
    """Serialize a ShareLink row for wire/cache use.

    2.15(a): rows store only the token hash, so the plaintext token (and
    therefore short_url) can only be included when the caller supplied it —
    creation responses and token-keyed lookups; page-keyed lookups after a
    cache miss get metadata only.
    """
    return {
        "token": token or "",
        "short_url": f"{base_url}/s/{token}" if token else "",
        "is_public": link.is_public,
        "expires_at": _ts(link.expires_at) if link.expires_at else 0,
        "view_count": link.view_count,
        "page_id": link.page_id,
        "user_id": link.user_id,
        "created_at": link.created_at.isoformat(),
        "revoked_at": link.revoked_at.isoformat() if link.revoked_at else "",
    }


def _dict_to_link_response(d):
    return share_pb2.ShareLinkResponse(**d)


def _cache_link_dict(key: str, data: dict) -> None:
    """Cache a link dict with a validity-bounded TTL (2.15c).

    An entry that could validate a token as valid=true is cached only for
    TTL_SHARE_VALID (≪ the old 30-minute window): if a validation read the
    DB just before a concurrent revocation committed and then writes its
    result, the stale entry cannot survive meaningfully longer than this
    window. Revoked/expired/private links validate to false regardless, so
    their metadata entries keep the longer TTL_SHARE_LINK.
    """
    active = (
        not data.get("revoked_at")
        and data.get("is_public")
        and (not data.get("expires_at") or data["expires_at"] > _ts(_utcnow()))
    )
    cache_set(key, data, TTL_SHARE_VALID if active else TTL_SHARE_LINK)


class ShareServicer(share_pb2_grpc.ShareServiceServicer):
    def __init__(self):
        self.engine = get_engine()
        # Dev default stays; production refuses to boot on it (see config.py).
        self.base_url = os.environ.get("BASE_URL", "http://localhost:8000")

    def _verify_page_ownership(self, user_id: str, page_id: str) -> bool:
        """Defense-in-depth page-ownership check against the archive service.

        Returns True only when the archive service confirms `page_id` exists
        and is owned by `user_id`. Any check failure (missing page, foreign
        page, archive unavailable) returns False — fail closed, and NOT_FOUND
        is surfaced uniformly so existence is never leaked.
        """
        stub = _get_archive_stub()
        if stub is None:
            return True  # not configured — gateway pre-check is the enforcement point
        try:
            stub.GetPage(archive_pb2.GetPageRequest(
                page_id=page_id, user_id=user_id,
            ), timeout=30)
            return True
        except grpc.RpcError as exc:
            logger.warning(
                "Page-ownership check failed for user %s page %s: %s",
                user_id, page_id, exc.code(),
            )
            return False

    def _find_active_link(self, session, user_id: str, page_id: str):
        """Active (non-revoked) link for a (user_id, page_id) pair, if any."""
        return session.execute(
            select(ShareLink).where(
                ShareLink.user_id == user_id,
                ShareLink.page_id == page_id,
                ShareLink.revoked_at.is_(None),
            )
        ).scalar_one_or_none()

    def CreateShareLink(self, request, context):
        # Mandatory page-ownership check (2.4): a page that is missing or
        # owned by someone else must never be linkable. NOT_FOUND covers both
        # cases without distinguishing them (no enumeration).
        if not self._verify_page_ownership(request.user_id, request.page_id):
            context.set_code(grpc.StatusCode.NOT_FOUND)
            context.set_details("Page not found")
            return share_pb2.ShareLinkResponse()

        # URL-facing token generation is unchanged (2.15a): 32 random bytes,
        # URL-safe base64 (43 chars). Only the stored value became a hash.
        token = secrets.token_urlsafe(32)
        if len(token) > 64:
            token = token[:64]
        token_hash = _hash_token(token)

        expires_at = None
        if request.expires_at:
            expires_at = _dt_from_ts(request.expires_at)

        now = _utcnow()
        try:
            with db_session(self.engine) as session:
                existing = self._find_active_link(
                    session, request.user_id, request.page_id
                )

                if existing and not _is_expired(existing, now):
                    # Already an active link for this pair — return it rather
                    # than create a duplicate (2.15). Hash-at-rest means the
                    # existing link's plaintext cannot be re-derived: serve
                    # the creation-time cache entry when present (it carries
                    # the token), otherwise metadata only.
                    ck_page = key_share_page(request.user_id, request.page_id)
                    data = cache_get(ck_page)
                    if data is None:
                        data = _link_to_dict(existing, self.base_url)
                        _cache_link_dict(ck_page, data)
                    if data.get("token"):
                        _cache_link_dict(key_share_token(existing.token_hash), data)
                    return _dict_to_link_response(data)

                if existing:
                    # Expired-but-not-revoked: retire it first so the partial
                    # active-link unique index admits the replacement.
                    existing.revoked_at = now
                    existing.active_page_id = None

                link = ShareLink(
                    token_hash=token_hash,
                    active_page_id=request.page_id,
                    user_id=request.user_id,
                    page_id=request.page_id,
                    is_public=request.is_public,
                    expires_at=expires_at,
                )
                session.add(link)
                # 2.15(b): if a concurrent create for the same (user_id,
                # page_id) committed first, this insert violates
                # uq_share_links_active — caught below, loser converges.
                session.flush()

                data = _link_to_dict(link, self.base_url, token=token)
                _cache_link_dict(key_share_token(token_hash), data)
                _cache_link_dict(key_share_page(request.user_id, request.page_id), data)

                return _dict_to_link_response(data)
        except IntegrityError:
            logger.info(
                "Concurrent CreateShareLink for (user %s, page %s) — returning "
                "the winner's link", request.user_id, request.page_id,
            )

        with db_session(self.engine) as session:
            winner = session.execute(
                select(ShareLink).where(
                    ShareLink.user_id == request.user_id,
                    ShareLink.page_id == request.page_id,
                    ShareLink.revoked_at.is_(None),
                ).order_by(ShareLink.created_at.desc())
            ).scalar_one_or_none()

        if winner is None:
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details("Share link creation conflict")
            return share_pb2.ShareLinkResponse()

        data = cache_get(key_share_page(request.user_id, request.page_id))
        if data is None:
            data = _link_to_dict(winner, self.base_url)
        return _dict_to_link_response(data)

    def _link_to_response(self, link):
        return _dict_to_link_response(_link_to_dict(link, self.base_url))

    def GetShareLink(self, request, context):
        ck = key_share_token(_hash_token(request.token))
        cached = cache_get(ck)
        if cached is not None:
            if cached.get("revoked_at"):
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Share link not found")
                return share_pb2.ShareLinkResponse()
            return _dict_to_link_response(cached)

        with db_session(self.engine) as session:
            link = session.execute(
                select(ShareLink).where(
                    ShareLink.token_hash == _hash_token(request.token)
                )
            ).scalar_one_or_none()

            if not link:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Share link not found")
                return share_pb2.ShareLinkResponse()

            data = _link_to_dict(link, self.base_url, token=request.token)
            _cache_link_dict(ck, data)
            return _dict_to_link_response(data)

    def GetShareLinkByPage(self, request, context):
        ck = key_share_page(request.user_id, request.page_id)
        cached = cache_get(ck)
        if cached is not None:
            if cached.get("revoked_at") or _is_expired(cached):
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

            if _is_expired(link):
                # An expired link is not an active share (2.15d): never
                # present it as one to the owner's management UI.
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("No active share link for this page")
                return share_pb2.ShareLinkResponse()

            # 2.15(a): the plaintext token is not recoverable from the stored
            # hash — page-keyed lookups after a cache miss return metadata
            # only (the creation response remains the one-time token reveal).
            data = _link_to_dict(link, self.base_url)
            _cache_link_dict(ck, data)
            _cache_link_dict(key_share_token(link.token_hash), data)
            return _dict_to_link_response(data)

    def RevokeShareLink(self, request, context):
        with db_session(self.engine) as session:
            link = session.execute(
                select(ShareLink).where(
                    ShareLink.token_hash == _hash_token(request.token)
                )
            ).scalar_one_or_none()

            if not link or link.user_id != request.user_id:
                return common_pb2.StatusResponse(success=False, message="not found")

            link.revoked_at = _utcnow()
            link.active_page_id = None
            page_owner = link.user_id
            page_id = link.page_id

            # 2.15(c): invalidate inside the transaction so a revocation is
            # visible the moment it commits. If the commit were to fail after
            # this delete, the cache simply repopulates from the (still
            # active) row — the safe failure direction. The residual race —
            # a validation that read the row pre-commit and writes its cache
            # entry after this delete — is bounded by TTL_SHARE_VALID
            # (see _cache_link_dict).
            cache_delete(key_share_token(_hash_token(request.token)))
            cache_delete(key_share_page(page_owner, page_id))

        return common_pb2.StatusResponse(success=True)

    def RevokeLinksForPage(self, request, context):
        """Revoke every share link referencing a page (2.3 / D6).

        Invoked best-effort by the archive service during DeletePage so no
        public link outlives its page. Idempotent: revoking a page with no
        active links still succeeds. No user scoping — the archive service
        calls this for its own deleted pages without user context.
        """
        now = _utcnow()
        revoked = []
        with db_session(self.engine) as session:
            if request.page_id:
                links = session.execute(
                    select(ShareLink).where(
                        ShareLink.page_id == request.page_id,
                        ShareLink.revoked_at.is_(None),
                    )
                ).scalars().all()

                for link in links:
                    link.revoked_at = now
                    link.active_page_id = None
                    revoked.append((link.token_hash, link.user_id))

        # Cache entries are keyed by token hash (2.15a), so they can be
        # invalidated right here — same critical path as RevokeShareLink.
        for token_hash, user_id in revoked:
            cache_delete(key_share_token(token_hash))
            cache_delete(key_share_page(user_id, request.page_id))

        if revoked:
            logger.info(
                "Revoked %d share link(s) for deleted page %s",
                len(revoked), request.page_id,
            )
        return common_pb2.StatusResponse(success=True)

    def _record_view(self, request, token_hash: str) -> None:
        """Record a validated view with Redis dedup (1.17).

        Redis INCR on a short-TTL key per (token hash, viewer fingerprint):
        the DB view_count is updated only when the INCR returns 1 (first hit
        of the window), so repeated asset hits no longer cost one synchronous
        UPDATE per request — on the cache-hit and DB paths alike. When Redis
        is unavailable (cache_incr → None) the legacy per-request DB
        increment is the fallback.

        The viewer fingerprint arrives in an optional additive proto field;
        until the gateway/proto contract carries it, all viewers of a token
        share one dedupe bucket (per-token, not per-viewer) — recorded as a
        contract gap for the follow-up proto revision.
        """
        viewer = getattr(request, "viewer_fingerprint", "") or "-"
        count = cache_incr(key_share_view(token_hash, viewer), TTL_VIEW_DEDUPE)
        if count == 1 or count is None:
            with db_session(self.engine) as session:
                session.execute(
                    update(ShareLink)
                    .where(ShareLink.token_hash == token_hash)
                    .values(view_count=ShareLink.view_count + 1)
                )

    def ValidateToken(self, request, context):
        token_hash = _hash_token(request.token)
        ck = key_share_token(token_hash)
        cached = cache_get(ck)
        if cached is not None:
            if cached.get("revoked_at") or not cached.get("is_public"):
                return share_pb2.ValidateShareResponse(valid=False)
            if cached.get("expires_at") and cached["expires_at"] < _ts(_utcnow()):
                cache_delete(ck)
                return share_pb2.ValidateShareResponse(valid=False)
            self._record_view(request, token_hash)
            # Share links are created only for pages the link owner owns, so
            # link.user_id IS the page owner (2.2) — downstream file access
            # uses it for the mandatory ownership check.
            return share_pb2.ValidateShareResponse(
                valid=True, page_id=cached["page_id"], owner_user_id=cached["user_id"],
            )

        with db_session(self.engine) as session:
            link = session.execute(
                select(ShareLink).where(ShareLink.token_hash == token_hash)
            ).scalar_one_or_none()

            if not link:
                return share_pb2.ValidateShareResponse(valid=False)

            data = _link_to_dict(link, self.base_url, token=request.token)

            if link.revoked_at is not None:
                cache_set(ck, data, TTL_SHARE_LINK)
                return share_pb2.ValidateShareResponse(valid=False)

            if not link.is_public:
                cache_set(ck, data, TTL_SHARE_LINK)
                return share_pb2.ValidateShareResponse(valid=False)

            if _is_expired(link):
                cache_set(ck, data, TTL_SHARE_LINK)
                return share_pb2.ValidateShareResponse(valid=False)

            self._record_view(request, token_hash)
            _cache_link_dict(ck, data)

            return share_pb2.ValidateShareResponse(
                valid=True, page_id=link.page_id, owner_user_id=link.user_id,
            )
