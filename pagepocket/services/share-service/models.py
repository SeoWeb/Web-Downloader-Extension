"""Share service SQLAlchemy models."""

import os
import sys
import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
from db import Base


def _uuid():
    return str(uuid.uuid4())


def _now():
    return datetime.now(UTC)


class ShareLink(Base):
    __tablename__ = "share_links"

    # 2.15(a): tokens are persisted only as SHA-256 hashes — the plaintext is
    # returned to the owner exactly once (at creation) and never stored.
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    page_id: Mapped[str] = mapped_column(String(36), nullable=False)
    # 2.15(b): MySQL has no partial indexes, so the "at most one active link
    # per (user_id, page_id)" rule is enforced with a nullable discriminator:
    # active_page_id holds the page_id while the link is active (revoked_at
    # IS NULL) and NULL once revoked. The unique index below admits any
    # number of revoked rows (NULL != NULL) but rejects a second active one
    # for the same (user_id, page_id) on both MySQL and SQLite. Maintained by
    # the servicer on create/revoke only.
    active_page_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    is_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    view_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    __table_args__ = (
        Index("uq_share_links_active", "user_id", "active_page_id", unique=True),
        Index("ix_share_links_page_id", "page_id"),
    )
