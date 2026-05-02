"""add size column to html_chunks

Revision ID: 005_html_chunks_size
Revises: 004_client_ext_id
Create Date: 2026-05-02 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "005_html_chunks_size"
down_revision: Union[str, None] = "004_client_ext_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add size column to html_chunks table."""
    op.add_column(
        "html_chunks",
        sa.Column(
            "size",
            sa.BigInteger,
            nullable=False,
            server_default="0",
            comment="HTML chunk size in bytes (UTF-8 encoded length)",
        ),
    )


def downgrade() -> None:
    """Remove size column from html_chunks table."""
    op.drop_column("html_chunks", "size")
