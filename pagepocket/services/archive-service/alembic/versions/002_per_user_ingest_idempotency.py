"""Per-user ingest idempotency: swap global unique on extension_job_id for (user_id, extension_job_id)

Revision ID: 002
Revises: 001
Create Date: 2026-10-15

Under the old schema a duplicate (user_id, extension_job_id) pair could not
exist (extension_job_id was globally unique), so the new composite unique
index can be created without a dedup pass.
"""
from collections.abc import Sequence

from alembic import op

revision: str = "002"
down_revision: str | None = "001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 001 created BOTH a column-level UNIQUE (MySQL index name: the column
    # name) and an explicit unique index ix_pages_extension_job_id.
    op.drop_index("ix_pages_extension_job_id", table_name="pages")
    op.drop_index("extension_job_id", table_name="pages")
    op.create_index(
        "ix_pages_user_job",
        "pages",
        ["user_id", "extension_job_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_pages_user_job", table_name="pages")
    op.create_index(
        "ix_pages_extension_job_id", "pages", ["extension_job_id"], unique=True
    )
    # Restore the column-level UNIQUE from 001.
    op.create_unique_constraint(
        "uq_pages_extension_job_id", "pages", ["extension_job_id"]
    )
