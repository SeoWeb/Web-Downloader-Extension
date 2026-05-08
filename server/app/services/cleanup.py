"""Periodic cleanup: expired sessions, stale sessions, orphaned API keys, orphaned dirs.

Cleanup runs:
  - On startup (stale session recovery, then expiry cleanup, then orphan cleanup)
  - Periodically (every ``cleanup_interval_hours``, default 1 hour)

Startup steps:
  1. Mark stale sessions in ``scraping``/``uploading`` status (last updated
     > 30 min ago) as ``failed``  — handles server-restart recovery.
  2. Mark ALL ``assembling`` sessions as ``failed``  — background tasks are
     lost on restart.
  3. Remove expired sessions and their files.
  4. Delete orphaned API keys (client records with no sessions and age > 30 days).
  5. Delete orphaned session directories (no matching DB record).

Periodic steps differ for assembling sessions (step 2):
  - Only mark sessions that have been ``assembling`` for > 30 min AND have no
    active task registered in ``AssemblyTaskManager``.
"""

import asyncio
import logging
import os
import shutil
from datetime import datetime, timedelta, timezone

import psutil

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.client import Client
from app.models.html_chunk import HtmlChunk
from app.models.resource import Resource
from app.models.session import Session, SessionStatus
from app.services.assembly_manager import assembly_task_manager
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
        self.disk_cleanup_threshold_pct = settings.disk_cleanup_threshold_pct
        self._background_task: asyncio.Task | None = None
        self._pool_monitor_task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # Disk usage helpers
    # ------------------------------------------------------------------

    def _get_disk_usage_pct(self) -> float:
        """Return disk usage percentage for the storage_root mount point."""
        usage = psutil.disk_usage(self.storage_root)
        return usage.percent

    def _get_disk_free_bytes(self) -> int:
        """Return free bytes on the storage_root mount point."""
        usage = psutil.disk_usage(self.storage_root)
        return usage.free

    def _dir_size(self, path: str) -> int:
        """Return total bytes used by a directory tree."""
        total = 0
        for dirpath, _dirnames, filenames in os.walk(path):
            for f in filenames:
                fp = os.path.join(dirpath, f)
                try:
                    total += os.path.getsize(fp)
                except OSError:
                    pass
        return total

    async def _remove_dir_async(self, path: str) -> None:
        """Remove a directory tree without blocking the async event loop."""
        def _remove() -> None:
            if os.path.exists(path):
                shutil.rmtree(path, ignore_errors=True)
        await asyncio.to_thread(_remove)

    async def _dir_size_async(self, path: str) -> int:
        """Return total bytes used by a directory tree (non-blocking)."""
        return await asyncio.to_thread(self._dir_size, path)

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

        try:
            # Step 1a: Mark stale scraping/uploading sessions as failed
            result["stale_sessions_failed"] = await self._mark_stale_sessions_failed(db)

            # Step 1b: Mark assembling sessions as failed
            result["assembling_sessions_failed"] = await self._mark_assembling_sessions_failed(db)

            # Commit the status changes before removing expired sessions
            await db.flush()

            # Step 2: Remove expired and old failed sessions
            result["expired_sessions_removed"] = await self._remove_expired_sessions(db)

            # Step 3: Clean up orphaned API keys
            result["orphaned_keys_removed"] = await self._cleanup_orphaned_api_keys(db)

            # Step 4: Clean up orphaned session directories
            result["orphaned_dirs_removed"] = await self._cleanup_orphaned_directories(db)

            # Step 5: Clean up orphaned DB records (no directory on disk)
            result["orphaned_sessions_removed"] = await self._cleanup_orphaned_db_records(db)

            await db.flush()
            logger.info("Startup cleanup complete: %s", result)

        except Exception:
            logger.exception("Error during startup cleanup")
            raise

        return result

    async def run_periodic_cleanup(self, db: AsyncSession) -> dict:
        """Run periodic cleanup.

        Unlike startup cleanup, this does NOT blanket-fail all assembling
        sessions. Instead, only assemblies that have been stale for longer
        than the timeout AND have no registered task are marked as failed.

        After normal cleanup, checks disk usage and triggers aggressive
        cleanup when usage exceeds the configured threshold.
        """
        logger.info("Running periodic cleanup...")
        disk_before = self._get_disk_usage_pct()
        result: dict = {}

        try:
            # Step 1a: Mark stale scraping/uploading sessions as failed
            result["stale_sessions_failed"] = await self._mark_stale_sessions_failed(db)

            # Step 1c: Mark stale assembling sessions as failed (age + no active task)
            result["stale_assembling_sessions_failed"] = await self._mark_stale_assembling_sessions_failed(db)

            await db.flush()

            # Step 2: Remove expired and old failed sessions
            result["expired_sessions_removed"] = await self._remove_expired_sessions(db)

            # Step 3: Clean up orphaned API keys
            result["orphaned_keys_removed"] = await self._cleanup_orphaned_api_keys(db)

            # Step 4: Clean up orphaned session directories
            result["orphaned_dirs_removed"] = await self._cleanup_orphaned_directories(db)

            # Step 5: Clean up orphaned DB records (no directory on disk)
            result["orphaned_sessions_removed"] = await self._cleanup_orphaned_db_records(db)

            await db.flush()

            # Step 6: Aggressive cleanup if disk usage exceeds threshold
            disk_after_normal = self._get_disk_usage_pct()

            if disk_after_normal > self.disk_cleanup_threshold_pct:
                logger.warning(
                    "Disk usage %.1f%% exceeds threshold %d%%, starting aggressive cleanup",
                    disk_after_normal,
                    self.disk_cleanup_threshold_pct,
                )
                result["aggressive_sessions_removed"] = await self._aggressive_cleanup(db)

            disk_after = self._get_disk_usage_pct()
            logger.info(
                "Periodic cleanup complete: %s (disk: %.1f%% → %.1f%%)",
                result,
                disk_before,
                disk_after,
            )

        except Exception:
            logger.exception("Error during periodic cleanup")
            raise

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
            if session.zip_path and await asyncio.to_thread(os.path.exists, session.zip_path):
                try:
                    await asyncio.to_thread(os.remove, session.zip_path)
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
    # Step 1c: Stale assembling sessions (periodic cleanup only)
    # ------------------------------------------------------------------

    async def _mark_stale_assembling_sessions_failed(self, db: AsyncSession) -> int:
        """Mark assembling sessions as failed only if stale AND no active task.

        Unlike startup cleanup (which blanket-fails all assembling sessions),
        periodic cleanup must not kill actively running assemblies. A session
        is considered stale if it has been in ``assembling`` status for longer
        than ``stale_timeout_minutes`` AND no task is registered in the
        in-process ``AssemblyTaskManager``.

        Returns:
            Number of sessions marked as failed.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(
            minutes=self.stale_timeout_minutes
        )

        stmt = select(Session).where(
            Session.status == SessionStatus.ASSEMBLING,
            Session.updated_at < cutoff,
        )
        result = await db.execute(stmt)
        sessions = result.scalars().all()

        count = 0
        for session in sessions:
            # Skip if an active assembly task is still running
            if assembly_task_manager.is_running(session.id):
                continue

            # Clean up partial output file
            if session.zip_path and await asyncio.to_thread(os.path.exists, session.zip_path):
                try:
                    await asyncio.to_thread(os.remove, session.zip_path)
                except OSError:
                    logger.warning(
                        "Failed to remove partial output: %s", session.zip_path
                    )

            await session_manager.mark_failed(
                session,
                db,
                error_message="Assembly timed out (no progress for {} minutes)".format(
                    self.stale_timeout_minutes
                ),
            )
            count += 1

        if count > 0:
            logger.info("Marked %d stale assembling sessions as failed", count)
        return count

    # ------------------------------------------------------------------
    # Step 2: Remove expired sessions
    # ------------------------------------------------------------------

    async def _remove_expired_sessions(self, db: AsyncSession) -> int:
        """Remove all expired sessions and their files.

        Three-pass approach:
          1. Mark all sessions past their expires_at as EXPIRED.
          2. Mark FAILED sessions older than 24 hours as EXPIRED.
          3. Batched bulk DELETE with per-batch commit for crash durability.
             We delete DB records FIRST, then files. If a crash occurs between
             the two, orphaned directory cleanup will catch the files later.

        Returns:
            Number of sessions removed.
        """
        now = datetime.now(timezone.utc)
        failed_cutoff = now - timedelta(hours=24)
        batch_size = 100
        total_count = 0

        # Pass 1: Mark all expired sessions as EXPIRED (bulk UPDATE)
        await db.execute(
            update(Session)
            .where(
                Session.expires_at <= now,
                Session.status != SessionStatus.EXPIRED,
            )
            .values(status=SessionStatus.EXPIRED)
        )

        # Pass 2: Mark FAILED sessions older than 24h as EXPIRED
        await db.execute(
            update(Session)
            .where(
                Session.status == SessionStatus.FAILED,
                Session.updated_at <= failed_cutoff,
            )
            .values(status=SessionStatus.EXPIRED)
        )
        await db.flush()

        # Pass 3: Delete expired sessions in batches with per-batch commit
        while True:
            stmt = (
                select(Session.id)
                .where(Session.status == SessionStatus.EXPIRED)
                .limit(batch_size)
            )
            result = await db.execute(stmt)
            batch_ids = [row[0] for row in result.all()]

            if not batch_ids:
                break

            # Bulk DELETE sessions FIRST — CASCADE removes resources + html_chunks
            # This ensures that even if file deletion fails or crashes, the session
            # is gone from the DB and won't be processed again.
            await db.execute(
                delete(Session).where(Session.id.in_(batch_ids))
            )
            await db.commit()

            # Delete files for this batch (non-blocking)
            for session_id in batch_ids:
                session_dir = os.path.join(self.storage_root, session_id)
                await self._remove_dir_async(session_dir)

            total_count += len(batch_ids)

        if total_count > 0:
            logger.info("Removed %d expired/failed sessions", total_count)
        return total_count

    # ------------------------------------------------------------------
    # Aggressive cleanup (disk-pressure triggered)
    # ------------------------------------------------------------------

    async def _aggressive_cleanup(self, db: AsyncSession) -> int:
        """Remove sessions approaching expiry when disk usage exceeds threshold.

        First removes all fully expired sessions (oldest first), then
        progressively removes sessions within 10% of their retention
        period until disk usage drops below the threshold.

        Returns:
            Number of sessions removed.
        """
        total_freed = 0
        total_removed = 0

        # Pass 1: Remove all fully expired sessions (oldest first)
        now = datetime.now(timezone.utc)
        stmt = (
            select(Session)
            .where(Session.expires_at <= now)
            .order_by(Session.expires_at.asc())
        )
        result = await db.execute(stmt)
        expired = result.scalars().all()

        if expired:
            session_ids = [s.id for s in expired]
            for session_id in session_ids:
                session_dir = os.path.join(self.storage_root, session_id)
                freed = await self._dir_size_async(session_dir) if await asyncio.to_thread(os.path.exists, session_dir) else 0
                total_freed += freed
                # Delete files (non-blocking)
                await self._remove_dir_async(session_dir)

            # Bulk DELETE sessions — CASCADE handles resources + html_chunks
            await db.execute(
                delete(Session).where(Session.id.in_(session_ids))
            )
            await db.commit()
            total_removed += len(expired)

        if self._get_disk_usage_pct() < self.disk_cleanup_threshold_pct:
            logger.info(
                "Aggressive cleanup pass 1 freed %d bytes (%d sessions), disk now %.1f%%",
                total_freed,
                total_removed,
                self._get_disk_usage_pct(),
            )
            return total_removed

        # Pass 2: Remove sessions within 10% of expiry
        retention_seconds = settings.default_retention_days * 86400
        margin = retention_seconds * 0.10
        near_expiry_cutoff = now + timedelta(seconds=margin)

        stmt = (
            select(Session)
            .where(Session.expires_at <= near_expiry_cutoff)
            .order_by(Session.expires_at.asc())
        )
        result = await db.execute(stmt)
        near_expiry = result.scalars().all()

        for session in near_expiry:
            if self._get_disk_usage_pct() < self.disk_cleanup_threshold_pct:
                break

            session_id = session.id
            session_dir = os.path.join(self.storage_root, session_id)
            freed = await self._dir_size_async(session_dir) if await asyncio.to_thread(os.path.exists, session_dir) else 0

            # Delete DB record FIRST
            await db.execute(
                delete(Session).where(Session.id == session_id)
            )
            await db.commit()

            # Then delete files
            await self._remove_dir_async(session_dir)

            total_freed += freed
            total_removed += 1

        await db.flush()

        logger.info(
            "Aggressive cleanup freed %d bytes (%d sessions), disk now %.1f%%",
            total_freed,
            total_removed,
            self._get_disk_usage_pct(),
        )
        return total_removed

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
        if not await asyncio.to_thread(os.path.exists, self.storage_root):
            return 0

        entries = await asyncio.to_thread(os.listdir, self.storage_root)
        count = 0
        for entry in entries:
            entry_path = os.path.join(self.storage_root, entry)
            is_dir = await asyncio.to_thread(os.path.isdir, entry_path)
            if not is_dir:
                continue

            # Check if the directory name looks like a UUID
            if len(entry) != 36 or entry.count("-") != 4:
                continue

            # Check if a session record exists
            stmt = select(Session.id).where(Session.id == entry)
            result = await db.execute(stmt)
            if result.scalar_one_or_none() is None:
                await self._remove_dir_async(entry_path)
                logger.info("Removed orphaned session directory: %s", entry)
                count += 1

        if count > 0:
            logger.info("Removed %d orphaned session directories", count)
        return count

    async def _cleanup_orphaned_db_records(self, db: AsyncSession) -> int:
        """Delete session records that have no corresponding directory on disk.

        Prevents 'zombie' sessions in the DB when storage was wiped or
        cleanup failed halfway. Skips sessions created in the last hour
        to avoid race conditions with session creation.

        Returns:
            Number of orphaned DB records removed.
        """
        now = datetime.now(timezone.utc)
        safety_cutoff = now - timedelta(hours=1)

        # Fetch candidate sessions (not EXPIRED)
        stmt = select(Session.id).where(
            Session.created_at < safety_cutoff,
            Session.status != SessionStatus.EXPIRED,
        )
        result = await db.execute(stmt)
        session_ids = [row[0] for row in result.all()]

        count = 0
        batch_ids = []
        for session_id in session_ids:
            session_dir = os.path.join(self.storage_root, session_id)
            if not await asyncio.to_thread(os.path.exists, session_dir):
                batch_ids.append(session_id)
                count += 1
                if len(batch_ids) >= 100:
                    await db.execute(delete(Session).where(Session.id.in_(batch_ids)))
                    await db.commit()
                    batch_ids = []

        if batch_ids:
            await db.execute(delete(Session).where(Session.id.in_(batch_ids)))
            await db.commit()

        if count > 0:
            logger.info("Removed %d orphaned DB records (missing disk directory)", count)
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
        self._pool_monitor_task = asyncio.create_task(
            self._pool_monitor_loop()
        )
        logger.info(
            "Periodic cleanup task started (interval: %d hour(s))",
            self.cleanup_interval_hours,
        )

    async def stop_periodic_cleanup(self) -> None:
        """Stop the periodic cleanup background task."""
        for task, name in [
            (self._background_task, "cleanup"),
            (self._pool_monitor_task, "pool monitor"),
        ]:
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._background_task = None
        self._pool_monitor_task = None
        logger.info("Periodic cleanup tasks stopped")

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

    async def _pool_monitor_loop(self) -> None:
        """Log connection pool status every 5 minutes."""
        while True:
            try:
                await asyncio.sleep(300)
            except asyncio.CancelledError:
                break

            try:
                from app.db.database import log_pool_status

                log_pool_status()
            except Exception:
                logger.debug("Could not log pool status", exc_info=True)


# Module-level singleton
cleanup_service = CleanupService()
