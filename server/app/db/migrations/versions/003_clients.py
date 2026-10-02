"""add clients table

Revision ID: 003_clients
Revises: 002_html_chunks
Create Date: 2026-04-22 14:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "003_clients"
down_revision: Union[str, None] = "002_html_chunks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create clients table for API key authentication."""

    op.create_table(
        "clients",
        sa.Column(
            "id",
            sa.String(36),
            primary_key=True,
        ),
        sa.Column(
            "api_key",
            sa.String(64),
            nullable=False,
            unique=True,
            comment="Cryptographically random API key for authentication",
        ),
        sa.Column(
            "name",
            sa.String(255),
            nullable=True,
            comment="Optional human-readable client name",
        ),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # Indexes for clients
    op.create_index(
        "ix_clients_api_key", "clients", ["api_key"], unique=True
    )
    op.create_index(
        "ix_clients_created_at", "clients", ["created_at"]
    )


def downgrade() -> None:
    """Drop clients table."""

    op.drop_index("ix_clients_created_at", table_name="clients")
    op.drop_index("ix_clients_api_key", table_name="clients")
    op.drop_table("clients")
