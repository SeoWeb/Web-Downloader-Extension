"""Add pagepocket cloud archive fields to sessions

Revision ID: 006
Revises: 005
Create Date: 2026-05-04
"""
from alembic import op
import sqlalchemy as sa

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sessions", sa.Column("pagepocket_user_id", sa.String(36), nullable=True, comment="PagePocket cloud user ID for cloud archive push"))
    op.add_column("sessions", sa.Column("cloud_status", sa.String(20), nullable=True, comment="Cloud push status: pending, success, failed"))
    op.add_column("sessions", sa.Column("cloud_page_id", sa.String(36), nullable=True, comment="Cloud archive page ID after successful push"))


def downgrade() -> None:
    op.drop_column("sessions", "cloud_page_id")
    op.drop_column("sessions", "cloud_status")
    op.drop_column("sessions", "pagepocket_user_id")
