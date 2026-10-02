"""add extension_instance_id to clients

Revision ID: 004_client_ext_id
Revises: 003_clients
Create Date: 2026-04-22 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "004_client_ext_id"
down_revision: Union[str, None] = "003_clients"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add extension_instance_id column to clients table for re-registration."""

    op.add_column(
        "clients",
        sa.Column(
            "extension_instance_id",
            sa.String(255),
            nullable=True,
            comment="Extension instance identifier for re-registration lookups",
        ),
    )

    op.create_index(
        "ix_clients_extension_instance_id",
        "clients",
        ["extension_instance_id"],
        unique=True,
    )


def downgrade() -> None:
    """Remove extension_instance_id column from clients table."""

    op.drop_index("ix_clients_extension_instance_id", table_name="clients")
    op.drop_column("clients", "extension_instance_id")
