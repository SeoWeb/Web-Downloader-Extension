"""Durable pending search-index flag on pages

Revision ID: 003
Revises: 002
Create Date: 2026-10-15

search_indexed is written False with the page insert (same transaction) and
flipped True only after SearchService.IndexPage succeeds. Existing rows are
backfilled to True — they were indexed (or permanently dropped) under the old
fire-and-forget behavior; only NEW ingests get the pending/retry guarantee.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "003"
down_revision: str | None = "002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "pages",
        sa.Column(
            "search_indexed",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("1"),  # backfill: treat existing rows as indexed
        ),
    )


def downgrade() -> None:
    op.drop_column("pages", "search_indexed")
