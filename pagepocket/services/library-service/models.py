"""Library service SQLAlchemy models."""

import os
import sys
import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
from db import Base


def _uuid():
    return str(uuid.uuid4())


def _now():
    return datetime.now(timezone.utc)


class Collection(Base):
    __tablename__ = "collections"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    parent_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("collections.id", ondelete="SET NULL"), nullable=True)
    color: Mapped[str] = mapped_column(String(7), nullable=False, default="#6B7280")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now, onupdate=_now)


class PageCollection(Base):
    __tablename__ = "page_collections"

    page_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    collection_id: Mapped[str] = mapped_column(String(36), ForeignKey("collections.id", ondelete="CASCADE"), primary_key=True)
    added_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now)


class Tag(Base):
    __tablename__ = "tags"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now)


class PageTag(Base):
    __tablename__ = "page_tags"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    page_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    tag_id: Mapped[str] = mapped_column(String(36), ForeignKey("tags.id", ondelete="CASCADE"), nullable=False, index=True)
