"""Initial share schema - share_links

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
        "share_links",
        sa.Column("token", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("page_id", sa.String(36), nullable=False),
        sa.Column("is_public", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("view_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_share_links_user_id", "share_links", ["user_id"])


def downgrade() -> None:
    op.drop_table("share_links")
