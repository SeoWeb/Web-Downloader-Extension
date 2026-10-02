"""Session lifecycle management: status transitions, validation, and storage.

Centralizes the rules for session state transitions:
    scraping  -> uploading, failed
    uploading -> assembling, failed
    assembling -> ready, failed
    ready     -> (terminal)
    failed    -> (terminal)
    expired   -> (terminal)
"""

import logging
import os
import shutil
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.session import Session, SessionStatus

logger = logging.getLogger(__name__)


# Valid status transitions: current_status -> set of allowed next statuses
VALID_TRANSITIONS: dict[SessionStatus, set[SessionStatus]] = {
    SessionStatus.SCRAPING: {SessionStatus.UPLOADING, SessionStatus.FAILED},
    SessionStatus.UPLOADING: {SessionStatus.ASSEMBLING, SessionStatus.FAILED},
    SessionStatus.ASSEMBLING: {SessionStatus.READY, SessionStatus.FAILED},
    SessionStatus.READY: set(),      # terminal
    SessionStatus.FAILED: set(),     # terminal
    SessionStatus.EXPIRED: set(),    # terminal
}


class SessionManager:
    """Manages session lifecycle transitions and file storage.

    Provides methods for:
    - Validating and executing status transitions
    - Creating and managing session storage directories
    - Marking sessions as failed with error messages
    - Touching updated_at to prevent stale-session detection
    """

    def __init__(self, storage_root: str, max_session_size_mb: int = 500) -> None:
        self.storage_root = storage_root
        self.max_session_size_mb = max_session_size_mb
        self.max_session_size_bytes = max_session_size_mb * 1024 * 1024

    # ------------------------------------------------------------------
    # Status transitions
    # ------------------------------------------------------------------

    def validate_transition(
        self, current: SessionStatus, target: SessionStatus
    ) -> None:
        """Validate that a status transition is allowed.

        Raises:
            ValueError: If the transition is not valid.
        """
        allowed = VALID_TRANSITIONS.get(current, set())
        if target not in allowed:
            raise ValueError(
                f"Invalid session transition: {current.value} -> {target.value}. "
                f"Allowed transitions from '{current.value}': "
                f"{[s.value for s in allowed] if allowed else 'none (terminal state)'}"
            )

    async def transition(
        self,
        session: Session,
        target: SessionStatus,
        db: AsyncSession,
        *,
        error_message: str | None = None,
    ) -> None:
        """Transition a session to a new status after validation.

        Args:
            session: The session ORM object.
            target: The desired new status.
            db: Async database session for flushing changes.
            error_message: Optional error description (used when target is FAILED).

        Raises:
            ValueError: If the transition is not valid.
        """
        self.validate_transition(session.status, target)

        old_status = session.status
        session.status = target
        if error_message and target == SessionStatus.FAILED:
            session.error_message = error_message

        await db.flush()

        logger.info(
            "Session transition: id=%s %s -> %s",
            session.id,
            old_status.value,
            target.value,
        )

    # ------------------------------------------------------------------
    # Scrape-complete transition (7.2): scraping -> uploading
    # ------------------------------------------------------------------

    async def scrape_complete(
        self,
        session: Session,
        db: AsyncSession,
        *,
        resource_count: int | None = None,
    ) -> None:
        """Transition session from scraping to uploading.

        Called after all HTML chunks have been uploaded.
        Optionally records the total number of discovered resources
        (from the scrape-complete signal payload) for UI progress display.

        Raises:
            ValueError: If session is not in 'scraping' status.
        """
        if session.status != SessionStatus.SCRAPING:
            raise ValueError(
                f"Cannot transition to uploading: session is in "
                f"'{session.status.value}' status, expected 'scraping'"
            )

        session.status = SessionStatus.UPLOADING
        if resource_count is not None:
            session.resources_discovered = resource_count

        await db.flush()
        logger.info("Session scrape-complete: id=%s", session.id)

    # ------------------------------------------------------------------
    # Finalization validation (7.3): reject if not in uploading status
    # ------------------------------------------------------------------

    def validate_finalize(self, session: Session) -> None:
        """Validate that a session can be finalized.

        Finalization is only accepted when the session is in 'uploading'
        status.  Sessions still in 'scraping' must call scrape-complete
        first.  Sessions already in 'assembling' or 'ready' are treated
        as a conflict (idempotent success from the client's perspective).

        Raises:
            ValueError: With a descriptive reason if finalization is rejected.
        """
        if session.status == SessionStatus.SCRAPING:
            raise ValueError(
                "Session is still in 'scraping' status. "
                "Call scrape-complete first."
            )
        if session.status in (SessionStatus.ASSEMBLING, SessionStatus.READY):
            raise ValueError(
                f"Session is already in '{session.status.value}' status"
            )
        if session.status != SessionStatus.UPLOADING:
            raise ValueError(
                f"Session is in '{session.status.value}' status, "
                f"expected 'uploading'"
            )

    # ------------------------------------------------------------------
    # Mark session as failed
    # ------------------------------------------------------------------

    async def mark_failed(
        self,
        session: Session,
        db: AsyncSession,
        error_message: str,
    ) -> None:
        """Mark a session as failed with an error message.

        Does NOT validate the transition — used by cleanup/recovery code
        that needs to force a failure regardless of current status.
        """
        old_status = session.status.value if isinstance(session.status, SessionStatus) else session.status
        session.status = SessionStatus.FAILED
        session.error_message = error_message
        await db.flush()
        logger.info(
            "Session marked as failed: id=%s (was %s): %s",
            session.id,
            old_status,
            error_message,
        )

    # ------------------------------------------------------------------
    # Mark session as ready
    # ------------------------------------------------------------------

    async def mark_ready(
        self,
        session: Session,
        db: AsyncSession,
        zip_path: str,
    ) -> None:
        """Mark a session as ready with the path to the assembled file."""
        session.status = SessionStatus.READY
        session.zip_path = zip_path
        session.assembly_phase = None
        session.assembly_progress_pct = None
        await db.flush()
        logger.info("Session marked as ready: id=%s", session.id)

    # ------------------------------------------------------------------
    # Touch updated_at (7.3a)
    # ------------------------------------------------------------------

    async def touch_updated_at(
        self, session: Session, db: AsyncSession
    ) -> None:
        """Explicitly touch the session's updated_at timestamp.

        This prevents the stale-session cleanup (task 7.6) from falsely
        expiring an active session that is uploading many small resources.
        The ``updated_at`` column has ``onupdate`` set, so simply mutating
        any field and flushing triggers the update.  However, calling this
        method makes the intent explicit and covers edge cases where no
        other field changes on a given request.

        Note: In practice, HTML chunk uploads and resource uploads already
        modify ``session.total_size`` (and ``html_chunks`` /
        ``resources_received`` counters) before flushing, which triggers
        ``onupdate`` automatically.  This method exists as a safety net
        for any future code paths that touch a session without modifying
        tracked counters.
        """
        # Force a change that triggers onupdate — incrementing a counter
        # that is already being tracked is cleaner than using raw SQL.
        # The updated_at column's onupdate callback handles the actual value.
        session.updated_at = datetime.now(timezone.utc)
        await db.flush()

    # ------------------------------------------------------------------
    # Session auto-expiry (7.4)
    # ------------------------------------------------------------------

    @staticmethod
    def compute_expires_at(
        retention_days: int | None = None,
    ) -> datetime:
        """Compute the expires_at timestamp for a new session.

        Args:
            retention_days: Days until expiry. Clamped to
                [min_retention_days, max_retention_days].
                Defaults to ``settings.default_retention_days``.
        """
        days = retention_days if retention_days is not None else settings.default_retention_days
        days = max(settings.min_retention_days, min(settings.max_retention_days, days))
        return datetime.now(timezone.utc) + timedelta(days=days)

    def is_expired(self, session: Session) -> bool:
        """Check whether a session has passed its expiry time."""
        now = datetime.now(timezone.utc)
        # Handle naive datetimes from MySQL (treat as UTC)
        expires = session.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        return now >= expires

    # ------------------------------------------------------------------
    # File storage management (7.7)
    # ------------------------------------------------------------------

    def get_session_dir(self, session_id: str) -> str:
        """Return the storage directory path for a session."""
        return os.path.join(self.storage_root, session_id)

    def get_resources_dir(self, session_id: str) -> str:
        """Return the resources subdirectory path for a session."""
        return os.path.join(self.storage_root, session_id, "resources")

    def get_output_dir(self, session_id: str) -> str:
        """Return the output subdirectory path for a session."""
        return os.path.join(self.storage_root, session_id, "output")

    def create_session_dirs(self, session_id: str) -> str:
        """Create session storage directories.

        Creates:
            <storage_root>/<session_id>/resources/

        Returns:
            The session directory path.
        """
        session_dir = self.get_session_dir(session_id)
        resources_dir = self.get_resources_dir(session_id)
        os.makedirs(resources_dir, exist_ok=True)
        return session_dir

    def create_output_dir(self, session_id: str) -> str:
        """Create the output directory for a session and return its path."""
        output_dir = self.get_output_dir(session_id)
        os.makedirs(output_dir, exist_ok=True)
        return output_dir

    def delete_session_files(self, session_id: str) -> bool:
        """Delete all files on disk for a session.

        Args:
            session_id: The session whose files should be removed.

        Returns:
            True if the directory existed and was removed.
        """
        session_dir = self.get_session_dir(session_id)
        if os.path.exists(session_dir):
            shutil.rmtree(session_dir, ignore_errors=True)
            logger.info("Deleted session files: id=%s", session_id)
            return True
        return False

    # ------------------------------------------------------------------
    # Session size tracking (7.10)
    # ------------------------------------------------------------------

    def check_size_limit(self, session: Session, additional_bytes: int) -> None:
        """Check whether adding additional_bytes would exceed the session size limit.

        Raises:
            ValueError: If the upload would exceed the maximum session size.
        """
        if session.total_size + additional_bytes > self.max_session_size_bytes:
            raise ValueError(
                f"Upload would exceed session size limit "
                f"({self.max_session_size_mb}MB). "
                f"Current: {session.total_size} bytes, "
                f"Upload: {additional_bytes} bytes, "
                f"Max: {self.max_session_size_bytes} bytes"
            )


# Module-level singleton
session_manager = SessionManager(
    storage_root=settings.storage_root,
    max_session_size_mb=settings.max_session_size_mb,
)
