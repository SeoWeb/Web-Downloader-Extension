"""HTML chunk database model."""

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, DateTime, Enum, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class PageType(str, enum.Enum):
    """Page type for HTML chunks (main page vs linked page)."""

    MAIN = "main"
    LINKED = "linked"


class HtmlChunk(Base):
    """HTML chunk record associated with a download session.

    Each chunk represents a scroll-indexed HTML fragment uploaded during
    the scraping phase. Chunks are grouped by session and page for assembly.
    """

    __tablename__ = "html_chunks"

    __table_args__ = (
        Index("ix_html_chunks_session_id", "session_id"),
        Index("ix_html_chunks_session_page", "session_id", "page_url_hash"),
        # Deduplication: same session + page + scroll_index + content = duplicate
        Index(
            "uq_html_chunks_dedup",
            "session_id",
            "page_url_hash",
            "scroll_index",
            "content_hash",
            unique=True,
        ),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    session_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
        comment="Parent session UUID",
    )
    page_type: Mapped[str] = mapped_column(
        Enum(PageType, values_callable=lambda e: [x.value for x in e]),
        nullable=False,
        default=PageType.MAIN,
        server_default=PageType.MAIN.value,
        comment="Whether this chunk belongs to the main page or a linked page",
    )
    page_url: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        comment="Full URL of the page (null for main page)",
    )
    page_url_hash: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="main",
        server_default="main",
        comment="First 16 hex chars of SHA-256(pageUrl), or 'main' for primary page",
    )
    scroll_index: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        comment="Scroll position index for ordering chunks within a page",
    )
    content_hash: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        comment="SHA-256 hex digest of the chunk HTML content",
    )
    storage_path: Mapped[str] = mapped_column(
        String(512),
        nullable=False,
        comment="Path to the chunk file on the server filesystem",
    )
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        server_default="CURRENT_TIMESTAMP",
    )

    def __repr__(self) -> str:
        return (
            f"<HtmlChunk id={self.id} session_id={self.session_id} "
            f"page_type={self.page_type} scroll_index={self.scroll_index}>"
        )
