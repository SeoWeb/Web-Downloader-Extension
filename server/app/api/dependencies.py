"""FastAPI dependencies for authentication and common request handling."""

import logging
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.models.client import Client

logger = logging.getLogger(__name__)

# Minimum interval between last_auth_at writes per client (write coalescing —
# avoids a DB write on every request while keeping orphan-client cleanup
# (6.4) fed with fresh "auth activity" timestamps).
_AUTH_TOUCH_INTERVAL_SECONDS = 3600


def _invalid_key_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={
            "error": "invalid_api_key",
            "message": "Invalid or unrecognized API key",
            "api_version": "v1",
        },
    )


async def authenticate_client(db: AsyncSession, api_key: str) -> Client | None:
    """Resolve an API key to its Client row (7.5 + 6.4 bookkeeping).

    Lookup strategy (7.5):
      1. SHA-256 hash lookup (``api_key_hash``) — the primary path once keys
         are hashed at rest.
      2. Plaintext fallback (``api_key``) — keeps legacy rows working until
         rotated. On a plaintext hit the hash column is populated lazily.

    On success, ``last_auth_at`` is refreshed at most once per hour
    (write coalescing) so the orphan-client cleanup pass can distinguish
    active identities from dead ones (6.4).

    Returns None when the key matches no client.
    """
    from app.models.client import hash_api_key

    client = None
    matched_via = None

    # 1. Hash lookup first
    key_hash = hash_api_key(api_key)
    result = await db.execute(
        select(Client).where(Client.api_key_hash == key_hash)
    )
    client = result.scalar_one_or_none()
    if client is not None:
        matched_via = "hash"

    # 2. Plaintext fallback (legacy rows — lazy hash migration)
    if client is None:
        result = await db.execute(
            select(Client).where(Client.api_key == api_key)
        )
        client = result.scalar_one_or_none()
        if client is not None:
            matched_via = "plaintext"
            if not client.api_key_hash:
                client.api_key_hash = key_hash
                logger.info(
                    "API key hash migrated lazily for client %s", client.id
                )

    if client is None:
        return None

    # Throttled last_auth_at touch (6.4): write at most once per hour.
    now = datetime.now(timezone.utc)
    last = client.last_auth_at
    if last is not None and last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    if (
        last is None
        or (now - last).total_seconds() >= _AUTH_TOUCH_INTERVAL_SECONDS
    ):
        client.last_auth_at = now

    logger.debug("Client authenticated via %s key: id=%s", matched_via, client.id)
    return client


async def get_current_client(
    x_api_key: str | None = Header(None, alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
) -> Client:
    """Validate X-API-Key header and return the authenticated client.

    Raises:
        HTTPException: 401 if the API key is missing or invalid.
    """
    if x_api_key is None:
        raise _invalid_key_error()

    client = await authenticate_client(db, x_api_key)

    if client is None:
        raise _invalid_key_error()

    return client


async def get_optional_client(
    x_api_key: str | None = Header(None, alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
) -> Client | None:
    """Return client if API key is provided, otherwise None.

    Used for endpoints that work with or without authentication.
    """
    if x_api_key is None:
        return None

    return await authenticate_client(db, x_api_key)


def require_session_owner(client: Client, session_client_id: str) -> None:
    """Verify that the client owns the session.

    Raises:
        HTTPException: 403 if the client does not own the session.
    """
    if client.id != session_client_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "forbidden",
                "message": "You do not have access to this session",
                "api_version": "v1",
            },
        )
