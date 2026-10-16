"""Alembic migration tests for share-service 002 (hash tokens at rest).

Runs the real migration chain programmatically against a temporary SQLite
database:

  upgrade 001 → seed plaintext rows (active + revoked) → upgrade 002:
    - token_hash backfilled = sha256(plaintext)
    - token column dropped (no plaintext at rest)
    - active_page_id = page_id for active rows, NULL for revoked
  downgrade 002 → 001: schema restored (lossy by design — hashes are
    irreversible; documented in the migration).
"""

import hashlib
import os
import sqlite3
import sys
import tempfile
import unittest

_shared = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared"))
_service = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))

sys.path.insert(0, _shared)
sys.path.insert(0, os.path.join(_shared, "proto_generated"))
sys.path.insert(0, _service)

from alembic import command
from alembic.config import Config

USER_A = "user-a-001"
USER_B = "user-b-002"


def _sha(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _columns(db_path):
    conn = sqlite3.connect(db_path)
    try:
        return {row[1] for row in conn.execute("PRAGMA table_info(share_links)")}
    finally:
        conn.close()


def _rows(db_path):
    conn = sqlite3.connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute("SELECT * FROM share_links")]
    finally:
        conn.close()


def _indexes(db_path):
    conn = sqlite3.connect(db_path)
    try:
        return {row[1] for row in conn.execute("PRAGMA index_list(share_links)")}
    finally:
        conn.close()


class TestTokenHashMigration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = os.path.join(self.tmp.name, "share_db.sqlite3")
        self.cfg = Config()
        self.cfg.set_main_option(
            "script_location", os.path.join(_service, "alembic")
        )
        self.cfg.set_main_option(
            "sqlalchemy.url", f"sqlite:///{self.db_path}"
        )
        # env.py prefers DB_URL when set — pin it to the scratch database so
        # a developer's environment cannot redirect the migration.
        self._env = os.environ.pop("DB_URL", None)
        os.environ["DB_URL"] = f"sqlite:///{self.db_path}"
        self.addCleanup(self._restore_env)

    def _restore_env(self):
        if self._env is None:
            os.environ.pop("DB_URL", None)
        else:
            os.environ["DB_URL"] = self._env

    def _seed_plaintext_rows(self):
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute(
                "INSERT INTO share_links (token, user_id, page_id, is_public,"
                " view_count, created_at) VALUES (?, ?, ?, 1, 0, '2026-01-01"
                " 00:00:00.000000')",
                ("plain-active-token-abc", USER_A, "page-1"),
            )
            conn.execute(
                "INSERT INTO share_links (token, user_id, page_id, is_public,"
                " view_count, created_at, revoked_at) VALUES (?, ?, ?, 1, 5,"
                " '2026-01-02 00:00:00.000000', '2026-01-03 00:00:00.000000')",
                ("plain-revoked-token-xyz", USER_B, "page-2"),
            )
            conn.commit()
        finally:
            conn.close()

    def test_upgrade_hashes_tokens_and_drops_plaintext(self):
        command.upgrade(self.cfg, "001")
        self._seed_plaintext_rows()

        command.upgrade(self.cfg, "head")

        cols = _columns(self.db_path)
        self.assertIn("token_hash", cols)
        self.assertIn("active_page_id", cols)
        self.assertNotIn("token", cols, "plaintext token column must be gone")

        rows = {r["user_id"]: r for r in _rows(self.db_path)}
        self.assertEqual(
            rows[USER_A]["token_hash"], _sha("plain-active-token-abc")
        )
        self.assertEqual(rows[USER_A]["active_page_id"], "page-1")
        self.assertEqual(
            rows[USER_B]["token_hash"], _sha("plain-revoked-token-xyz")
        )
        self.assertIsNone(rows[USER_B]["active_page_id"])

        self.assertIn("uq_share_links_active", _indexes(self.db_path))

    def test_upgrade_enforces_single_active_link(self):
        command.upgrade(self.cfg, "001")
        self._seed_plaintext_rows()
        command.upgrade(self.cfg, "head")

        conn = sqlite3.connect(self.db_path)
        try:
            # A second active link for a DIFFERENT page is fine.
            conn.execute(
                "INSERT INTO share_links (token_hash, active_page_id, user_id,"
                " page_id, is_public, view_count, created_at)"
                " VALUES (?, ?, ?, ?, 1, 0, '2026-01-04 00:00:00.000000')",
                ("a" * 64, "page-9", USER_A, "page-9"),
            )
            conn.commit()
            # A second ACTIVE link for the same (user_id, page_id) is blocked.
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO share_links (token_hash, active_page_id, user_id,"
                    " page_id, is_public, view_count, created_at)"
                    " VALUES (?, ?, ?, ?, 1, 0, '2026-01-05 00:00:00.000000')",
                    ("b" * 64, "page-1", USER_A, "page-1"),
                )
                conn.commit()
        finally:
            conn.close()

    def test_downgrade_restores_schema_lossily(self):
        command.upgrade(self.cfg, "001")
        self._seed_plaintext_rows()
        command.upgrade(self.cfg, "head")

        command.downgrade(self.cfg, "001")

        cols = _columns(self.db_path)
        self.assertIn("token", cols)
        self.assertNotIn("token_hash", cols)
        self.assertNotIn("active_page_id", cols)
        # Rows survive (hash values carried into token — documented lossy).
        rows = {r["user_id"]: r for r in _rows(self.db_path)}
        self.assertEqual(
            rows[USER_A]["token"], _sha("plain-active-token-abc")
        )


if __name__ == "__main__":
    unittest.main()
