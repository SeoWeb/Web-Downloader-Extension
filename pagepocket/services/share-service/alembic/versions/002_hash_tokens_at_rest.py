"""Hash share tokens at rest + enforce one active link per (user, page)

Revision ID: 002
Revises: 001
Create Date: 2026-10-16

harden-pagepocket-platform 2.15:

- (a) ``token`` (plaintext, primary key) is replaced by ``token_hash``
  (SHA-256 hex, primary key). The plaintext is shown to the owner exactly
  once at creation and is NOT recoverable, so this revision backfills the
  hashes from the existing plaintext rows first (share_db is tiny) and only
  then swaps the primary key and drops the plaintext column.
- (b) adds the ``active_page_id`` discriminator column + the unique
  index ``uq_share_links_active (user_id, active_page_id)`` so two concurrent
  CreateShareLink calls can never both produce an active link for the same
  (user_id, page_id) pair (MySQL has no partial indexes; NULL
  active_page_id
  rows — revoked links — are exempt from the index on every backend).

The downgrade is necessarily lossy: hashes cannot be reversed into plaintext
tokens, so the restored 001 schema carries the hash values in ``token``.
"""
import hashlib
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "002"
down_revision: str | None = "001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _table_pre_swap() -> sa.Table:
    """The share_links schema as it exists mid-upgrade (after the two new
    columns were added, before the primary-key swap / column drop)."""
    metadata = sa.MetaData()
    return sa.Table(
        "share_links",
        metadata,
        sa.Column("token", sa.String(64), primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=True),
        sa.Column("active_page_id", sa.String(36), nullable=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("page_id", sa.String(36), nullable=False),
        sa.Column("is_public", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("view_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Index("ix_share_links_user_id", "user_id"),
    )


def _table_002() -> sa.Table:
    """The target (002) share_links schema."""
    metadata = sa.MetaData()
    return sa.Table(
        "share_links",
        metadata,
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("active_page_id", sa.String(36), nullable=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("page_id", sa.String(36), nullable=False),
        sa.Column("is_public", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("view_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Index("ix_share_links_user_id", "user_id"),
    )


def _table_002_with_token() -> sa.Table:
    """The 002 schema plus the downgrade's plaintext-carrying ``token``
    column (hash values copied in before the final swap)."""
    metadata = sa.MetaData()
    return sa.Table(
        "share_links",
        metadata,
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("token", sa.String(64), nullable=True),
        sa.Column("active_page_id", sa.String(36), nullable=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("page_id", sa.String(36), nullable=False),
        sa.Column("is_public", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("view_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Index("ix_share_links_user_id", "user_id"),
    )


def upgrade() -> None:
    op.add_column("share_links", sa.Column("token_hash", sa.String(64), nullable=True))
    op.add_column("share_links", sa.Column("active_page_id", sa.String(36), nullable=True))

    # Backfill in Python: read the plaintext, write its hash. share_db is
    # tiny (one row per created share link), so a row-by-row pass is fine.
    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT token, page_id, revoked_at FROM share_links")
    ).fetchall()
    for token, page_id, revoked_at in rows:
        digest = _hash(token)
        conn.execute(
            sa.text(
                "UPDATE share_links SET token_hash = :h, active_page_id = :a WHERE token = :t"
            ),
            {"h": digest, "a": None if revoked_at else page_id, "t": token},
        )

    dialect = op.get_context().dialect.name
    if dialect == "mysql":
        # MySQL: direct DDL (batch recreate would copy the table needlessly).
        conn.execute(sa.text("ALTER TABLE share_links DROP PRIMARY KEY"))
        conn.execute(sa.text("ALTER TABLE share_links MODIFY token_hash VARCHAR(64) NOT NULL"))
        conn.execute(sa.text("ALTER TABLE share_links ADD PRIMARY KEY (token_hash)"))
        conn.execute(sa.text("ALTER TABLE share_links DROP COLUMN token"))
    else:
        # SQLite cannot drop a PRIMARY KEY column in place — rebuild the
        # table with the new shape (copy_from pins the exact source schema).
        with op.batch_alter_table(
            "share_links", recreate="always", copy_from=_table_pre_swap()
        ) as batch:
            batch.drop_column("token")
            batch.create_primary_key("pk_share_links", ["token_hash"])

    op.create_index(
        "uq_share_links_active", "share_links", ["user_id", "active_page_id"], unique=True
    )
    op.create_index("ix_share_links_page_id", "share_links", ["page_id"])


def downgrade() -> None:
    """Restore the 001 schema shape.

    LOSSY by design: SHA-256 cannot be reversed, so ``token`` is repopulated
    from ``token_hash``. Rows survive, but links minted under 002 will not
    validate against the downgraded schema.
    """
    op.drop_index("ix_share_links_page_id", table_name="share_links")
    op.drop_index("uq_share_links_active", table_name="share_links")

    dialect = op.get_context().dialect.name
    if dialect == "mysql":
        conn = op.get_bind()
        conn.execute(sa.text("ALTER TABLE share_links ADD COLUMN token VARCHAR(64) NULL"))
        conn.execute(sa.text("UPDATE share_links SET token = token_hash"))
        conn.execute(sa.text("ALTER TABLE share_links DROP PRIMARY KEY"))
        conn.execute(sa.text("ALTER TABLE share_links MODIFY token VARCHAR(64) NOT NULL"))
        conn.execute(sa.text("ALTER TABLE share_links MODIFY token_hash VARCHAR(64) NULL"))
        conn.execute(sa.text("ALTER TABLE share_links ADD PRIMARY KEY (token)"))
        conn.execute(sa.text("ALTER TABLE share_links DROP COLUMN token_hash"))
        conn.execute(sa.text("ALTER TABLE share_links DROP COLUMN active_page_id"))
    else:
        # SQLite: rebuild in two pinned-shape passes — first add the plaintext
        # column and copy the hash values into it, then restore the 001 shape.
        with op.batch_alter_table(
            "share_links", recreate="always", copy_from=_table_002()
        ) as batch:
            batch.add_column(sa.Column("token", sa.String(64), nullable=True))
        conn = op.get_bind()
        conn.execute(sa.text("UPDATE share_links SET token = token_hash"))
        with op.batch_alter_table(
            "share_links", recreate="always", copy_from=_table_002_with_token()
        ) as batch:
            batch.drop_column("token_hash")
            batch.drop_column("active_page_id")
            batch.create_primary_key("pk_share_links", ["token"])
