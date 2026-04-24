"""FastAPI dependencies for authentication and common request handling."""

import logging

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.models.client import Client

logger = logging.getLogger(__name__)


async def get_current_client(
    x_api_key: str = Header(..., alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
) -> Client:
    """Validate X-API-Key header and return the authenticated client.

    Raises:
        HTTPException: 401 if the API key is missing or invalid.
    """
    stmt = select(Client).where(Client.api_key == x_api_key)
    result = await db.execute(stmt)
    client = result.scalar_one_or_none()

    if client is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": "invalid_api_key",
                "message": "Invalid or unrecognized API key",
                "api_version": "v1",
            },
        )

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

    stmt = select(Client).where(Client.api_key == x_api_key)
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


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
