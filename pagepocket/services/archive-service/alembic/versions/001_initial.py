"""Initial archive schema - pages and user_quotas

Revision ID: 001
Revises:
Create Date: 2026-05-04
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "pages",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("preview_text", sa.Text(), nullable=True),
        sa.Column("r2_key", sa.String(500), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("extension_job_id", sa.String(36), unique=True, nullable=True),
        sa.Column("archived_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_pages_user_id", "pages", ["user_id"])
    op.create_index("idx_archived_at", "pages", ["archived_at"])
    op.create_index("ix_pages_extension_job_id", "pages", ["extension_job_id"], unique=True)

    op.create_table(
        "user_quotas",
        sa.Column("user_id", sa.String(36), primary_key=True),
        sa.Column("pages_this_month", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("quota_reset_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("user_quotas")
    op.drop_table("pages")
