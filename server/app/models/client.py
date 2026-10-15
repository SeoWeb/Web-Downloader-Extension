"""Client (API key holder) database model."""

import hashlib
import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


def _generate_api_key() -> str:
    """Generate a cryptographically random API key (32 bytes hex)."""
    return secrets.token_hex(32)


def hash_api_key(api_key: str) -> str:
    """SHA-256 hex digest of an API key (at-rest lookup hash, 7.5)."""
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


class Client(Base):
    """Registered extension client identified by API key.

    Each extension instance auto-registers and receives a unique API key.
    The key is used to isolate sessions and data between clients.
    """

    __tablename__ = "clients"

    __table_args__ = (
        Index("ix_clients_api_key", "api_key", unique=True),
        Index("ix_clients_api_key_hash", "api_key_hash"),
        Index("ix_clients_extension_instance_id", "extension_instance_id", unique=True),
        Index("ix_clients_created_at", "created_at"),
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
    extension_instance_id: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
        unique=True,
        comment="Extension instance identifier for re-registration lookups",
    )
    api_key: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        unique=True,
        default=_generate_api_key,
        comment="Cryptographically random API key for authentication",
    )
    api_key_hash: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
        comment="SHA-256 of api_key for at-rest hash lookup (7.5); "
        "legacy rows have this populated lazily on first successful auth",
    )
    name: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
        comment="Optional human-readable client name",
    )
    pagepocket_user_id: Mapped[str | None] = mapped_column(
        String(36),
        nullable=True,
        comment="PagePocket cloud user ID for cloud archive push",
    )
    pagepocket_plan: Mapped[str | None] = mapped_column(
        String(32),
        nullable=True,
        comment="PagePocket plan recorded at binding time (free/pro); "
        "authoritative plan for cloud push billing",
    )
    pagepocket_linked_at: Mapped[datetime | None] = mapped_column(
        DateTime,
        nullable=True,
        comment="When the cloud binding was last (re-)verified via AuthService.Verify",
    )
    last_auth_at: Mapped[datetime | None] = mapped_column(
        DateTime,
        nullable=True,
        comment="Last successful API-key authentication (throttled writes); "
        "drives orphan-client cleanup (6.4)",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        server_default="CURRENT_TIMESTAMP",
    )

    @staticmethod
    def hash_key(api_key: str) -> str:
        """Return the at-rest lookup hash for an API key."""
        return hash_api_key(api_key)

    def __repr__(self) -> str:
        return f"<Client id={self.id} api_key={self.api_key[:8]}...>"
