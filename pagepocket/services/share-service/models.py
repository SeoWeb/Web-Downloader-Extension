"""Share service SQLAlchemy models."""

import os
import sys
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
from db import Base


def _uuid():
    return str(uuid.uuid4())


def _now():
    return datetime.now(timezone.utc)


class ShareLink(Base):
    __tablename__ = "share_links"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    page_id: Mapped[str] = mapped_column(String(36), nullable=False)
    is_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    view_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
