"""Client cloud-binding fields and API-key hash (harden-backend-security-and-ops 3.1/6.4/7.5)

Revision ID: 008
Revises: 007
Create Date: 2026-10-15
"""
import sqlalchemy as sa
from alembic import op

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 3.1 — cloud identity binding lives on the client row (written only by
    # the authenticated POST /api/v1/cloud/link flow), never by session options.
    op.add_column("clients", sa.Column("pagepocket_plan", sa.String(32), nullable=True, comment="PagePocket plan recorded at binding time (free/pro); authoritative plan for cloud push billing"))
    op.add_column("clients", sa.Column("pagepocket_linked_at", sa.DateTime, nullable=True, comment="When the cloud binding was last (re-)verified via AuthService.Verify"))
    # 6.4 — last successful auth timestamp for orphan-client cleanup
    op.add_column("clients", sa.Column("last_auth_at", sa.DateTime, nullable=True, comment="Last successful API-key authentication (throttled writes); drives orphan-client cleanup"))
    # 7.5 — SHA-256 lookup hash; legacy plaintext rows are migrated lazily on
    # first successful auth. Plaintext api_key is kept until keys are rotated.
    op.add_column("clients", sa.Column("api_key_hash", sa.String(64), nullable=True, comment="SHA-256 of api_key for at-rest hash lookup"))
    op.create_index("ix_clients_api_key_hash", "clients", ["api_key_hash"])

    # 3.2 — plan stamped onto the session at creation from the client binding,
    # so the cloud push always carries the authoritative plan.
    op.add_column("sessions", sa.Column("pagepocket_plan", sa.String(32), nullable=True, comment="PagePocket plan copied from the client binding at session creation"))


def downgrade() -> None:
    op.drop_column("sessions", "pagepocket_plan")
    op.drop_index("ix_clients_api_key_hash", table_name="clients")
    op.drop_column("clients", "api_key_hash")
    op.drop_column("clients", "last_auth_at")
    op.drop_column("clients", "pagepocket_linked_at")
    op.drop_column("clients", "pagepocket_plan")
