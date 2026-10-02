"""initial tables sessions and resources

Revision ID: 001_initial
Revises:
Create Date: 2026-04-22 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create sessions and resources tables with InnoDB, utf8mb4, and indexes."""

    # --- sessions table ---
    op.create_table(
        "sessions",
        sa.Column(
            "id",
            sa.String(36),
            primary_key=True,
        ),
        sa.Column(
            "client_id",
            sa.String(36),
            nullable=False,
            comment="API key / registered client identifier",
        ),
        sa.Column(
            "url",
            sa.Text,
            nullable=False,
            comment="Original page URL being downloaded",
        ),
        sa.Column(
            "status",
            sa.Enum(
                "scraping",
                "uploading",
                "assembling",
                "ready",
                "failed",
                "expired",
                name="sessionstatus",
            ),
            nullable=False,
            server_default="scraping",
        ),
        sa.Column(
            "options",
            mysql.JSON,
            nullable=True,
            comment="Session options: singleFile, retentionDays, etc.",
        ),
        sa.Column(
            "html_chunks",
            sa.BigInteger,
            nullable=False,
            server_default="0",
            comment="Count of uploaded HTML chunks",
        ),
        sa.Column(
            "resources_discovered",
            sa.BigInteger,
            nullable=True,
            comment="Total resources discovered (from scrape-complete signal)",
        ),
        sa.Column(
            "resources_received",
            sa.BigInteger,
            nullable=False,
            server_default="0",
            comment="Count of uploaded resources",
        ),
        sa.Column(
            "total_size",
            sa.BigInteger,
            nullable=False,
            server_default="0",
            comment="Total stored size in bytes",
        ),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.text(
                "CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
            ),
        ),
        sa.Column(
            "finalized_at",
            sa.DateTime,
            nullable=True,
            comment="Timestamp when finalization was requested",
        ),
        sa.Column(
            "expires_at",
            sa.DateTime,
            nullable=False,
            comment="When the session expires and should be cleaned up",
        ),
        sa.Column(
            "zip_path",
            sa.String(512),
            nullable=True,
            comment="Path to assembled ZIP or HTML file on disk",
        ),
        sa.Column(
            "filename_map",
            mysql.JSON,
            nullable=True,
            comment="URL-to-local-filename mapping for image resources",
        ),
        sa.Column(
            "assembly_phase",
            sa.String(50),
            nullable=True,
            comment="Current assembly phase: merging_html, converting_urls, converting_css, assembling_zip",
        ),
        sa.Column(
            "assembly_progress_pct",
            sa.BigInteger,
            nullable=True,
            comment="Progress percentage for current assembly phase (0-100)",
        ),
        sa.Column(
            "error_message",
            sa.Text,
            nullable=True,
            comment="Error description if session failed",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # Indexes for sessions
    op.create_index(
        "ix_sessions_client_id", "sessions", ["client_id"]
    )
    op.create_index(
        "ix_sessions_status", "sessions", ["status"]
    )
    op.create_index(
        "ix_sessions_expires_at", "sessions", ["expires_at"]
    )

    # --- resources table ---
    op.create_table(
        "resources",
        sa.Column(
            "id",
            sa.String(36),
            primary_key=True,
        ),
        sa.Column(
            "session_id",
            sa.String(36),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
            comment="Parent session UUID",
        ),
        sa.Column(
            "original_url",
            sa.Text,
            nullable=False,
            comment="Original URL of the resource as fetched by the extension",
        ),
        sa.Column(
            "url_hash",
            sa.String(64),
            nullable=False,
            comment="SHA-256 hex digest of original_url for indexing and deduplication",
        ),
        sa.Column(
            "local_path",
            sa.String(512),
            nullable=True,
            comment="Path within the ZIP archive (e.g. images/photo.jpg)",
        ),
        sa.Column(
            "storage_path",
            sa.String(512),
            nullable=False,
            comment="Absolute path to the file on the server filesystem",
        ),
        sa.Column(
            "content_type",
            sa.String(255),
            nullable=True,
            comment="MIME type of the resource",
        ),
        sa.Column(
            "size",
            sa.BigInteger,
            nullable=False,
            server_default="0",
            comment="File size in bytes (uncompressed)",
        ),
        sa.Column(
            "uploaded_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        # Unique constraint prevents duplicate resource uploads per session
        sa.UniqueConstraint(
            "session_id",
            "url_hash",
            name="uq_resources_session_url_hash",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # Indexes for resources
    op.create_index(
        "ix_resources_session_id", "resources", ["session_id"]
    )
    op.create_index(
        "ix_resources_url_hash", "resources", ["url_hash"]
    )


def downgrade() -> None:
    """Drop resources and sessions tables."""
    op.drop_index("ix_resources_url_hash", table_name="resources")
    op.drop_index("ix_resources_session_id", table_name="resources")
    op.drop_table("resources")

    op.drop_index("ix_sessions_expires_at", table_name="sessions")
    op.drop_index("ix_sessions_status", table_name="sessions")
    op.drop_index("ix_sessions_client_id", table_name="sessions")
    op.drop_table("sessions")
