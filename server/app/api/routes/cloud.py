"""Cloud link routes: PagePocket identity binding (harden-backend-security-and-ops 3.1).

``POST /api/v1/cloud/link`` — the ONLY flow that may write a client's cloud
binding. The client proves both identities: a valid ``X-API-Key`` and a
PagePocket access token verified against the auth service. Session creation
and the cloud push derive their identity exclusively from this binding.

``DELETE /api/v1/cloud/link`` — the logout mirror: clears the binding on the
authenticated client (same ``X-API-Key`` identity), keeping the API key
itself valid. Idempotent, no auth-service call.
"""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_current_client
from app.db.database import get_db
from app.models.client import Client
from app.services import auth_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/cloud", tags=["cloud"])


class CloudLinkRequest(BaseModel):
    """Request body for the cloud identity binding."""

    access_token: str = Field(
        ...,
        min_length=1,
        description="PagePocket access token (verified against AuthService.Verify)",
    )


class CloudLinkResponse(BaseModel):
    """Response body for a successful binding."""

    bound: bool = True
    pagepocket_user_id: str
    plan: str | None = None
    api_version: str = "v1"


class CloudUnlinkResponse(BaseModel):
    """Response body for a successful unbinding."""

    bound: bool = False
    api_version: str = "v1"


@router.post(
    "/link",
    response_model=CloudLinkResponse,
    summary="Bind a PagePocket identity to this API-key client",
    description=(
        "Verifies the supplied PagePocket access token via AuthService.Verify "
        "and stores the returned user id (and plan) as this client's cloud "
        "binding. Re-running the link flow refreshes the binding and plan."
    ),
)
async def cloud_link(
    body: CloudLinkRequest,
    client: Client = Depends(get_current_client),  # noqa: B008
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> CloudLinkResponse:
    """Bind (or refresh) the client's PagePocket cloud identity."""
    if not auth_client.is_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "cloud_link_unavailable",
                "message": "Cloud identity binding is not configured on this server",
                "api_version": "v1",
            },
        )

    result = await _verify(body.access_token)

    if not result.valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": "invalid_pagepocket_token",
                "message": "PagePocket access token could not be verified",
                "api_version": "v1",
            },
        )

    # Store the binding on the client row (never accepted from session options).
    client.pagepocket_user_id = result.user_id
    client.pagepocket_plan = result.plan
    client.pagepocket_linked_at = datetime.now(timezone.utc)
    await db.commit()

    logger.info(
        "Cloud identity bound: client=%s user=%s plan=%s",
        client.id, result.user_id, result.plan,
    )
    return CloudLinkResponse(
        pagepocket_user_id=result.user_id,
        plan=result.plan,
    )


@router.delete(
    "/link",
    response_model=CloudUnlinkResponse,
    summary="Unbind the PagePocket identity from this API-key client",
    description=(
        "Clears this client's cloud binding (user id, plan, linked-at) while "
        "keeping the API key valid. Idempotent: unbinding an already-unbound "
        "client still succeeds, so a retried logout never errors."
    ),
)
async def cloud_unlink(
    client: Client = Depends(get_current_client),  # noqa: B008
    db: AsyncSession = Depends(get_db),  # noqa: B008
) -> CloudUnlinkResponse:
    """Clear the client's PagePocket cloud identity (logout mirror of link).

    Clears exactly the three binding columns written by ``cloud_link`` and
    touches nothing else: the client row (``api_key``, ``last_auth_at``)
    stays authenticable so the extension identity survives a PagePocket
    logout. Idempotent by construction — an already-unbound client simply
    commits a no-op and still returns success.
    """
    was_user_id = client.pagepocket_user_id

    client.pagepocket_user_id = None
    client.pagepocket_plan = None
    client.pagepocket_linked_at = None
    await db.commit()

    logger.info(
        "Cloud identity unbound: client=%s was_user=%s",
        client.id, was_user_id or "none",
    )
    return CloudUnlinkResponse()


async def _verify(token: str) -> auth_client.VerifyResult:
    """Run the blocking gRPC verify off the event loop."""
    import asyncio

    return await asyncio.to_thread(auth_client.verify_token, token)
