"""Add pagepocket_user_id and cloud_error to clients/sessions

Revision ID: 007
Revises: 006
Create Date: 2026-05-04
"""
from alembic import op
import sqlalchemy as sa

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("clients", sa.Column("pagepocket_user_id", sa.String(36), nullable=True, comment="PagePocket cloud user ID for cloud archive push"))
    op.add_column("sessions", sa.Column("cloud_error", sa.Text, nullable=True, comment="gRPC error details from failed cloud push"))


def downgrade() -> None:
    op.drop_column("sessions", "cloud_error")
    op.drop_column("clients", "pagepocket_user_id")
