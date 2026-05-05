"""Initial search schema - page_index with FULLTEXT ngram

Revision ID: 001
Revises:
Create Date: 2026-05-04
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "page_index",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("page_id", sa.String(36), unique=True, nullable=False),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("body_text", sa.Text().with_variant(sa.dialects.mysql.MEDIUMTEXT(), "mysql"), nullable=True),
        sa.Column("tags", sa.Text(), nullable=True),
        sa.Column("archived_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_page_index_page_id", "page_index", ["page_id"], unique=True)
    op.create_index("ix_page_index_user_id", "page_index", ["user_id"])

    op.execute(
        "CREATE FULLTEXT INDEX ft_page_index ON page_index (title, body_text) WITH PARSER ngram"
    )


def downgrade() -> None:
    op.execute("DROP INDEX ft_page_index ON page_index")
    op.drop_table("page_index")
