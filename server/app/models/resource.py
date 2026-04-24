"""Resource database model."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Resource(Base):
    """Resource file record associated with a download session.

    Tracks individual resources (images, CSS, JS, fonts, documents)
    uploaded by the extension during a download session.
    """

    __tablename__ = "resources"

    # InnoDB with utf8mb4; unique constraint on url_hash avoids TEXT index limitation
    __table_args__ = (
        UniqueConstraint(
            "session_id",
            "url_hash",
            name="uq_resources_session_url_hash",
        ),
        Index("ix_resources_session_id", "session_id"),
        Index("ix_resources_url_hash", "url_hash"),
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
    original_url: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Original URL of the resource as fetched by the extension",
    )
    url_hash: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        comment="SHA-256 hex digest of original_url for indexing and deduplication",
    )
    local_path: Mapped[str | None] = mapped_column(
        String(512),
        nullable=True,
        comment="Path within the ZIP archive (e.g. images/photo.jpg)",
    )
    storage_path: Mapped[str] = mapped_column(
        String(512),
        nullable=False,
        comment="Absolute path to the file on the server filesystem",
    )
    content_type: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
        comment="MIME type of the resource",
    )
    size: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        default=0,
        server_default="0",
        comment="File size in bytes (uncompressed)",
    )
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        server_default="CURRENT_TIMESTAMP",
    )

    def __repr__(self) -> str:
        return f"<Resource id={self.id} session_id={self.session_id} local_path={self.local_path}>"
