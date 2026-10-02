"""Initial library schema - collections, page_collections, tags, page_tags

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
        "collections",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("parent_id", sa.String(36), sa.ForeignKey("collections.id", ondelete="SET NULL"), nullable=True),
        sa.Column("color", sa.String(7), nullable=False, server_default="#6B7280"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_collections_user_id", "collections", ["user_id"])

    op.create_table(
        "page_collections",
        sa.Column("page_id", sa.String(36), primary_key=True),
        sa.Column("collection_id", sa.String(36), sa.ForeignKey("collections.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("added_at", sa.DateTime(), nullable=False),
    )

    op.create_table(
        "tags",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_tags_user_id", "tags", ["user_id"])

    op.create_table(
        "page_tags",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("page_id", sa.String(36), nullable=False),
        sa.Column("tag_id", sa.String(36), sa.ForeignKey("tags.id", ondelete="CASCADE"), nullable=False),
    )
    op.create_index("ix_page_tags_page_id", "page_tags", ["page_id"])
    op.create_index("ix_page_tags_tag_id", "page_tags", ["tag_id"])


def downgrade() -> None:
    op.drop_table("page_tags")
    op.drop_table("tags")
    op.drop_table("page_collections")
    op.drop_table("collections")
