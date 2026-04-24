"""add html_chunks table

Revision ID: 002_html_chunks
Revises: 001_initial
Create Date: 2026-04-22 13:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "002_html_chunks"
down_revision: Union[str, None] = "001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create html_chunks table."""

    op.create_table(
        "html_chunks",
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
            "page_type",
            sa.Enum("main", "linked", name="pagetype"),
            nullable=False,
            server_default="main",
            comment="Whether this chunk belongs to the main page or a linked page",
        ),
        sa.Column(
            "page_url",
            sa.Text,
            nullable=True,
            comment="Full URL of the page (null for main page)",
        ),
        sa.Column(
            "page_url_hash",
            sa.String(16),
            nullable=False,
            server_default="main",
            comment="First 16 hex chars of SHA-256(pageUrl), or 'main' for primary page",
        ),
        sa.Column(
            "scroll_index",
            sa.Integer,
            nullable=False,
            comment="Scroll position index for ordering chunks within a page",
        ),
        sa.Column(
            "content_hash",
            sa.String(64),
            nullable=False,
            comment="SHA-256 hex digest of the chunk HTML content",
        ),
        sa.Column(
            "storage_path",
            sa.String(512),
            nullable=False,
            comment="Path to the chunk file on the server filesystem",
        ),
        sa.Column(
            "uploaded_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # Indexes for html_chunks
    op.create_index(
        "ix_html_chunks_session_id", "html_chunks", ["session_id"]
    )
    op.create_index(
        "ix_html_chunks_session_page",
        "html_chunks",
        ["session_id", "page_url_hash"],
    )
    op.create_index(
        "uq_html_chunks_dedup",
        "html_chunks",
        ["session_id", "page_url_hash", "scroll_index", "content_hash"],
        unique=True,
    )


def downgrade() -> None:
    """Drop html_chunks table."""

    op.drop_index("uq_html_chunks_dedup", table_name="html_chunks")
    op.drop_index("ix_html_chunks_session_page", table_name="html_chunks")
    op.drop_index("ix_html_chunks_session_id", table_name="html_chunks")
    op.drop_table("html_chunks")
