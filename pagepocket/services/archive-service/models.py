"""Archive service SQLAlchemy models."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, BigInteger, DateTime, Text, Integer
from sqlalchemy.orm import Mapped, mapped_column

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
from db import Base


def _uuid():
    return str(uuid.uuid4())


def _now():
    return datetime.now(timezone.utc)


class Page(Base):
    __tablename__ = "pages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    preview_text: Mapped[str] = mapped_column(Text, nullable=True)
    r2_key: Mapped[str] = mapped_column(String(500), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    extension_job_id: Mapped[str] = mapped_column(String(36), unique=True, nullable=True, index=True)
    archived_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now)


class UserQuota(Base):
    __tablename__ = "user_quotas"

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    pages_this_month: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    quota_reset_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now)


PLAN_LIMITS = {
    "free": {"pages_per_month": 50, "max_bytes": 500 * 1024 * 1024},       # 500 MB
    "pro": {"pages_per_month": 99999, "max_bytes": 10 * 1024 * 1024 * 1024},  # 10 GB
    "team": {"pages_per_month": 99999, "max_bytes": 50 * 1024 * 1024 * 1024}, # 50 GB
}
