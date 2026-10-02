"""Assembly task manager: track and cancel in-progress assembly tasks.

When a session is deleted while in 'assembling' status, the background
assembly task must be cancelled before cleanup. This module provides
a simple in-process registry for that purpose.
"""

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


class AssemblyTaskManager:
    """Registry for in-progress assembly tasks.

    Thread-safety note: designed for single-process async (uvicorn).
    For multi-worker deployments, use a shared store (e.g. Redis).
    """

    def __init__(self, max_concurrent_assemblies: int = 2) -> None:
        self._tasks: dict[str, asyncio.Task[Any]] = {}
        self._semaphore = asyncio.Semaphore(max_concurrent_assemblies)

    @property
    def semaphore(self) -> asyncio.Semaphore:
        """Get the concurrency semaphore for assembly tasks."""
        return self._semaphore

    def register(self, session_id: str, task: asyncio.Task[Any]) -> None:
        """Register an assembly task for a session."""
        self._tasks[session_id] = task
        logger.info("Registered assembly task for session %s", session_id)

    def unregister(self, session_id: str) -> None:
        """Remove a completed/failed task from the registry."""
        self._tasks.pop(session_id, None)

    async def cancel(self, session_id: str, timeout: float = 5.0) -> bool:
        """Cancel an in-progress assembly task and wait for it to finish.

        Args:
            session_id: The session whose assembly task should be cancelled.
            timeout: Seconds to wait for the task to finish after cancellation.

        Returns:
            True if the task was found and cancelled, False if no task was found.
        """
        task = self._tasks.get(session_id)
        if task is None:
            return False

        if task.done():
            self.unregister(session_id)
            return True

        logger.info("Cancelling assembly task for session %s", session_id)
        task.cancel()

        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning(
                "Assembly task for session %s did not finish within %.1fs",
                session_id,
                timeout,
            )
        except asyncio.CancelledError:
            pass  # Expected — the task was cancelled
        except Exception:
            logger.exception(
                "Assembly task for session %s raised an exception during cancellation",
                session_id,
            )
        finally:
            self.unregister(session_id)

        return True

    def is_running(self, session_id: str) -> bool:
        """Check whether an assembly task is currently running for a session."""
        task = self._tasks.get(session_id)
        return task is not None and not task.done()


# Module-level singleton — imported by route handlers
assembly_task_manager = AssemblyTaskManager()
