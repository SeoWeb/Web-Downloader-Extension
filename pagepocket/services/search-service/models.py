"""Search service SQLAlchemy models."""

import os
import sys
import uuid
from datetime import datetime, timezone

import sqlalchemy.dialects.mysql
from sqlalchemy import DateTime, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
from db import Base


def _uuid():
    return str(uuid.uuid4())


def _now():
    return datetime.now(timezone.utc)


class PageIndex(Base):
    __tablename__ = "page_index"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    page_id: Mapped[str] = mapped_column(String(36), unique=True, nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    body_text: Mapped[str | None] = mapped_column(
        Text().with_variant(sqlalchemy.dialects.mysql.MEDIUMTEXT(), "mysql"),
        nullable=True,
    )
    tags: Mapped[str | None] = mapped_column(Text, nullable=True)
    archived_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now)

    __table_args__ = (
        Index("ft_page_index", "title", "body_text", mysql_prefix="FULLTEXT", mysql_with_parser="ngram"),
    )
