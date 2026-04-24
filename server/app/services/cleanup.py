"""Periodic cleanup: expired sessions, stale sessions, orphaned API keys, orphaned dirs.

Cleanup runs:
  - On startup (stale session recovery, then expiry cleanup, then orphan cleanup)
  - Periodically (every ``cleanup_interval_hours``, default 1 hour)

Steps on each run:
  1. Mark stale sessions in ``scraping``/``uploading`` status (last updated
     > 30 min ago) as ``failed``  — handles server-restart recovery.
  2. Mark ``assembling`` sessions as ``failed``  — handles interrupted assembly.
  3. Remove expired sessions and their files.
  4. Delete orphaned API keys (client records with no sessions and age > 30 days).
  5. Delete orphaned session directories (no matching DB record).
"""

import asyncio
import logging
import os
import shutil
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.client import Client
from app.models.html_chunk import HtmlChunk
from app.models.resource import Resource
from app.models.session import Session, SessionStatus
from app.services.session_manager import session_manager

logger = logging.getLogger(__name__)


class CleanupService:
    """Manages cleanup of expired sessions, stale sessions, and orphaned data."""

    def __init__(
        self,
        storage_root: str | None = None,
        stale_timeout_minutes: int | None = None,
        orphaned_key_age_days: int | None = None,
        cleanup_interval_hours: int | None = None,
    ) -> None:
        self.storage_root = storage_root or settings.storage_root
        self.stale_timeout_minutes = (
            stale_timeout_minutes or settings.stale_session_timeout_minutes
        )
        self.orphaned_key_age_days = (
            orphaned_key_age_days or settings.orphaned_api_key_age_days
        )
        self.cleanup_interval_hours = (
            cleanup_interval_hours or settings.cleanup_interval_hours
        )
        self._background_task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # Top-level cleanup orchestration
    # ------------------------------------------------------------------

    async def run_startup_cleanup(self, db: AsyncSession) -> dict:
        """Run startup cleanup: stale sessions, then expired, then orphans.

        Order matters:
        1. Stale sessions are marked as failed first (so they don't get
           cleaned up as "expired" in step 2).
        2. Expired sessions are removed (files + DB).
        3. Orphaned API keys are cleaned up.
        4. Orphaned session directories are removed.

        Returns:
            Dict with counts of each cleanup action performed.
        """
        logger.info("Running startup cleanup...")
        result: dict = {}

        # Step 1a: Mark stale scraping/uploading sessions as failed
        result["stale_sessions_failed"] = await self._mark_stale_sessions_failed(db)

        # Step 1b: Mark assembling sessions as failed
        result["assembling_sessions_failed"] = await self._mark_assembling_sessions_failed(db)

        # Commit the status changes before removing expired sessions
        await db.flush()

        # Step 2: Remove expired sessions and files
        result["expired_sessions_removed"] = await self._remove_expired_sessions(db)

        # Step 3: Clean up orphaned API keys
        result["orphaned_keys_removed"] = await self._cleanup_orphaned_api_keys(db)

        # Step 4: Clean up orphaned session directories
        result["orphaned_dirs_removed"] = await self._cleanup_orphaned_directories(db)

        await db.flush()

        logger.info("Startup cleanup complete: %s", result)
        return result

    async def run_periodic_cleanup(self, db: AsyncSession) -> dict:
        """Run periodic cleanup (same steps as startup cleanup)."""
        logger.info("Running periodic cleanup...")
        result = await self.run_startup_cleanup(db)
        logger.info("Periodic cleanup complete: %s", result)
        return result

    # ------------------------------------------------------------------
    # Step 1a: Stale sessions (scraping/uploading, last updated > 30 min)
    # ------------------------------------------------------------------

    async def _mark_stale_sessions_failed(self, db: AsyncSession) -> int:
        """Mark stale sessions in scraping/uploading status as failed.

        A session is considered stale if its **last activity time** is
        older than ``stale_timeout_minutes`` (default 30 minutes).  Last
        activity is defined as the greatest of:

        1. ``session.updated_at`` (touched by status transitions)
        2. The most recent ``resources.created_at`` for this session
        3. The most recent ``html_chunks.created_at`` for this session

        This avoids touching the session row during uploads (which would
        cause MySQL deadlocks) while still accurately detecting stale
        sessions.

        Returns:
            Number of sessions marked as failed.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(
            minutes=self.stale_timeout_minutes
        )

        # Use a SQL-level comparison that accounts for child-table
        # activity, so we never need to UPDATE the session row during
        # uploads (deadlock prevention).  Both Resource and HtmlChunk
        # use "uploaded_at" as their timestamp column.
        last_activity = func.greatest(
            Session.updated_at,
            func.coalesce(
                select(func.max(Resource.uploaded_at))
                .where(Resource.session_id == Session.id)
                .correlate(Session)
                .scalar_subquery(),
                Session.updated_at,
            ),
            func.coalesce(
                select(func.max(HtmlChunk.uploaded_at))
                .where(HtmlChunk.session_id == Session.id)
                .correlate(Session)
                .scalar_subquery(),
                Session.updated_at,
            ),
        )

        stmt = select(Session).where(
            Session.status.in_([SessionStatus.SCRAPING, SessionStatus.UPLOADING]),
            last_activity < cutoff,
        )
        result = await db.execute(stmt)
        sessions = result.scalars().all()

        count = 0
        for session in sessions:
            await session_manager.mark_failed(
                session,
                db,
                error_message=(
                    "Session marked as failed: server restarted while "
                    "session was in '{}' status (last activity > {} min ago)".format(
                        session.status.value, self.stale_timeout_minutes
                    )
                ),
            )
            count += 1

        if count > 0:
            logger.info("Marked %d stale sessions as failed", count)
        return count

    # ------------------------------------------------------------------
    # Step 1b: Assembling sessions (always stale on restart)
    # ------------------------------------------------------------------

    async def _mark_assembling_sessions_failed(self, db: AsyncSession) -> int:
        """Mark all assembling sessions as failed.

        On server restart, any session that was being assembled is
        unrecoverable — the background task was lost.  Mark it as
        failed and clean up the partial output.

        Returns:
            Number of sessions marked as failed.
        """
        stmt = select(Session).where(Session.status == SessionStatus.ASSEMBLING)
        result = await db.execute(stmt)
        sessions = result.scalars().all()

        count = 0
        for session in sessions:
            # Clean up partial output file
            if session.zip_path and os.path.exists(session.zip_path):
                try:
                    os.remove(session.zip_path)
                except OSError:
                    logger.warning(
                        "Failed to remove partial output: %s", session.zip_path
                    )

            await session_manager.mark_failed(
                session,
                db,
                error_message="Assembly was interrupted by server restart",
            )
            count += 1

        if count > 0:
            logger.info("Marked %d assembling sessions as failed", count)
        return count

    # ------------------------------------------------------------------
    # Step 2: Remove expired sessions
    # ------------------------------------------------------------------

    async def _remove_expired_sessions(self, db: AsyncSession) -> int:
        """Remove all expired sessions and their files.

        A session is expired if its ``expires_at`` timestamp is in the past.
        Per spec, the session is first marked as ``expired`` before deletion,
        so any polling client can observe the terminal status before the
        record is removed.

        Processes sessions in batches of 100 to avoid loading all expired
        sessions into memory at once (e.g., after a long server downtime).

        Returns:
            Number of sessions removed.
        """
        now = datetime.now(timezone.utc)
        batch_size = 100
        total_count = 0

        while True:
            stmt = select(Session).where(Session.expires_at <= now).limit(batch_size)
            result = await db.execute(stmt)
            sessions = result.scalars().all()

            if not sessions:
                break

            for session in sessions:
                # Mark as expired first (spec: two-step process)
                if session.status != SessionStatus.EXPIRED:
                    session.status = SessionStatus.EXPIRED
                    await db.flush()

                # Delete resource records (cascade should handle this, but explicit is safer)
                resource_stmt = select(Resource).where(
                    Resource.session_id == session.id
                )
                resource_result = await db.execute(resource_stmt)
                for resource in resource_result.scalars().all():
                    await db.delete(resource)

                # Delete session files from disk
                session_dir = os.path.join(self.storage_root, session.id)
                if os.path.exists(session_dir):
                    shutil.rmtree(session_dir, ignore_errors=True)

                # Delete session record
                await db.delete(session)
                total_count += 1

            await db.flush()

        if total_count > 0:
            logger.info("Removed %d expired sessions", total_count)
        return total_count

    # ------------------------------------------------------------------
    # Step 3: Orphaned API key cleanup (7.9)
    # ------------------------------------------------------------------

    async def _cleanup_orphaned_api_keys(self, db: AsyncSession) -> int:
        """Delete client records with no sessions and age > 30 days.

        Prevents unbounded accumulation of API keys from extension
        instances that registered but never created any sessions, or
        whose sessions have all expired and been cleaned up.

        Returns:
            Number of orphaned client records deleted.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(
            days=self.orphaned_key_age_days
        )

        # Find clients with no sessions and created before the cutoff
        # Use a subquery to count sessions per client
        session_count_stmt = (
            select(Session.client_id, func.count().label("session_count"))
            .group_by(Session.client_id)
            .subquery()
        )

        stmt = (
            select(Client)
            .outerjoin(
                session_count_stmt,
                Client.id == session_count_stmt.c.client_id,
            )
            .where(
                Client.created_at <= cutoff,
                # No sessions at all, or session_count is NULL (left join)
                session_count_stmt.c.session_count.is_(None),
            )
        )
        result = await db.execute(stmt)
        orphaned_clients = result.scalars().all()

        count = 0
        for client in orphaned_clients:
            await db.delete(client)
            count += 1

        if count > 0:
            logger.info("Removed %d orphaned API keys", count)
        return count

    # ------------------------------------------------------------------
    # Step 4: Orphaned session directories
    # ------------------------------------------------------------------

    async def _cleanup_orphaned_directories(self, db: AsyncSession) -> int:
        """Delete session directories that have no corresponding DB record.

        Covers cases where a crash occurred between DB record deletion
        and disk file deletion.

        Returns:
            Number of orphaned directories removed.
        """
        if not os.path.exists(self.storage_root):
            return 0

        count = 0
        for entry in os.listdir(self.storage_root):
            entry_path = os.path.join(self.storage_root, entry)
            if not os.path.isdir(entry_path):
                continue

            # Check if the directory name looks like a UUID
            if len(entry) != 36 or entry.count("-") != 4:
                continue

            # Check if a session record exists
            stmt = select(Session.id).where(Session.id == entry)
            result = await db.execute(stmt)
            if result.scalar_one_or_none() is None:
                shutil.rmtree(entry_path, ignore_errors=True)
                logger.info("Removed orphaned session directory: %s", entry)
                count += 1

        if count > 0:
            logger.info("Removed %d orphaned session directories", count)
        return count

    # ------------------------------------------------------------------
    # Background task management
    # ------------------------------------------------------------------

    async def start_periodic_cleanup(self) -> None:
        """Start the periodic cleanup background task."""
        if self._background_task is not None:
            logger.warning("Periodic cleanup task already running")
            return

        self._background_task = asyncio.create_task(
            self._periodic_cleanup_loop()
        )
        logger.info(
            "Periodic cleanup task started (interval: %d hour(s))",
            self.cleanup_interval_hours,
        )

    async def stop_periodic_cleanup(self) -> None:
        """Stop the periodic cleanup background task."""
        if self._background_task is None:
            return

        self._background_task.cancel()
        try:
            await self._background_task
        except asyncio.CancelledError:
            pass
        self._background_task = None
        logger.info("Periodic cleanup task stopped")

    async def _periodic_cleanup_loop(self) -> None:
        """Run periodic cleanup at the configured interval."""
        interval_seconds = self.cleanup_interval_hours * 3600

        while True:
            try:
                await asyncio.sleep(interval_seconds)
            except asyncio.CancelledError:
                break

            try:
                from app.db.database import async_session_factory

                async with async_session_factory() as db:
                    try:
                        await self.run_periodic_cleanup(db)
                        await db.commit()
                    except Exception:
                        await db.rollback()
                        raise
            except Exception:
                logger.exception("Error during periodic cleanup")


# Module-level singleton
cleanup_service = CleanupService()
