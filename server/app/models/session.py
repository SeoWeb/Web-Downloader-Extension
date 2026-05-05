"""Session database model."""

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, DateTime, Enum, Index, String, Text
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class SessionStatus(str, enum.Enum):
    """Valid session statuses with enforced transition rules.

    scraping  -> uploading, failed
    uploading -> assembling, failed
    assembling -> ready, failed
    ready     -> (terminal)
    failed    -> (terminal)
    expired   -> (terminal)
    """

    SCRAPING = "scraping"
    UPLOADING = "uploading"
    ASSEMBLING = "assembling"
    READY = "ready"
    FAILED = "failed"
    EXPIRED = "expired"


class Session(Base):
    """Download session record.

    Tracks the lifecycle of a single website download from scraping
    through assembly to ready-for-download.
    """

    __tablename__ = "sessions"

    # InnoDB with utf8mb4 for proper Unicode support and row-level locking
    __table_args__ = (
        Index("ix_sessions_client_id", "client_id"),
        Index("ix_sessions_status", "status"),
        Index("ix_sessions_expires_at", "expires_at"),
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
    client_id: Mapped[str] = mapped_column(
        String(36),
        nullable=False,
        comment="API key / registered client identifier",
    )
    url: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Original page URL being downloaded",
    )
    status: Mapped[str] = mapped_column(
        Enum(SessionStatus, values_callable=lambda e: [x.value for x in e]),
        nullable=False,
        default=SessionStatus.SCRAPING,
        server_default=SessionStatus.SCRAPING.value,
    )
    options: Mapped[dict | None] = mapped_column(
        JSON,
        nullable=True,
        comment="Session options: singleFile, retentionDays, etc.",
    )
    html_chunks: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        default=0,
        server_default="0",
        comment="Count of uploaded HTML chunks",
    )
    resources_discovered: Mapped[int | None] = mapped_column(
        BigInteger,
        nullable=True,
        comment="Total resources discovered (from scrape-complete signal)",
    )
    resources_received: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        default=0,
        server_default="0",
        comment="Count of uploaded resources",
    )
    total_size: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        default=0,
        server_default="0",
        comment="Total stored size in bytes",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        server_default="CURRENT_TIMESTAMP",
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        server_default="CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
    )
    finalized_at: Mapped[datetime | None] = mapped_column(
        DateTime,
        nullable=True,
        comment="Timestamp when finalization was requested",
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        comment="When the session expires and should be cleaned up",
    )
    zip_path: Mapped[str | None] = mapped_column(
        String(512),
        nullable=True,
        comment="Path to assembled ZIP or HTML file on disk",
    )
    filename_map: Mapped[dict | None] = mapped_column(
        JSON,
        nullable=True,
        comment="URL-to-local-filename mapping for image resources",
    )
    assembly_phase: Mapped[str | None] = mapped_column(
        String(50),
        nullable=True,
        comment="Current assembly phase: merging_html, converting_urls, converting_css, assembling_zip",
    )
    assembly_progress_pct: Mapped[int | None] = mapped_column(
        BigInteger,
        nullable=True,
        comment="Progress percentage for current assembly phase (0-100)",
    )
    error_message: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        comment="Error description if session failed",
    )
    pagepocket_user_id: Mapped[str | None] = mapped_column(
        String(36),
        nullable=True,
        comment="PagePocket cloud user ID for cloud archive push",
    )
    cloud_status: Mapped[str | None] = mapped_column(
        String(20),
        nullable=True,
        comment="Cloud push status: pending, success, failed",
    )
    cloud_page_id: Mapped[str | None] = mapped_column(
        String(36),
        nullable=True,
        comment="Cloud archive page ID after successful push",
    )
    cloud_error: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        comment="gRPC error details from failed cloud push",
    )

    def __repr__(self) -> str:
        return f"<Session id={self.id} status={self.status} url={self.url[:80]}>"
