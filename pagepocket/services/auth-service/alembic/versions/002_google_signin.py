"""Google sign-in columns - nullable unique google_sub, nullable password_hash

Revision ID: 002
Revises: 001
Create Date: 2026-10-22
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "002"
down_revision: str | None = "001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # easier-auth D5: Google-created accounts carry their Google subject as
    # the stable cross-provider identity. Nullable: password accounts keep
    # NULL until they sign in with Google once (auto-link stores it).
    op.add_column("users", sa.Column("google_sub", sa.String(255), nullable=True))
    op.create_index("ix_users_google_sub", "users", ["google_sub"], unique=True)

    # Google-created accounts have no password: relax the NOT NULL so
    # GoogleAuth can create passwordless users.
    op.alter_column("users", "password_hash", existing_type=sa.String(255), nullable=True)


def downgrade() -> None:
    # Restores nullability only as feasible: any surviving NULL password_hash
    # row (Google-only account) makes the ALTER fail on the DB side — those
    # accounts must be resolved by an operator before downgrading. The
    # google_sub link data is dropped with the column (re-linking happens on
    # the next Google sign-in).
    op.alter_column("users", "password_hash", existing_type=sa.String(255), nullable=False)
    op.drop_index("ix_users_google_sub", table_name="users")
    op.drop_column("users", "google_sub")
