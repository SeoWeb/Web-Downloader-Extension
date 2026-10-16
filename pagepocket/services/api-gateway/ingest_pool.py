"""Dedicated bounded executor for ingest-class upstream calls (D1).

The default AnyIO worker thread pool (~40 threads) is shared by every
``run_in_threadpool`` dispatch in the process. A burst of concurrent large
ingests — each holding a worker for up to the 120 s ingest deadline — could
exhaust that pool and starve every other route (including /api/v1/health).

Ingest-class stub calls therefore run on this dedicated ``ThreadPoolExecutor``:
at most ``GATEWAY_INGEST_WORKERS`` (default 4) pushes execute concurrently,
excess ingests queue on the executor's work queue without touching the shared
pool, and short-lived routes keep their full capacity.
"""

import asyncio
import functools
import os
from concurrent.futures import ThreadPoolExecutor

INGEST_WORKERS_ENV = "GATEWAY_INGEST_WORKERS"

DEFAULT_INGEST_WORKERS = 4


def ingest_workers(raw: str | None = None) -> int:
    """Parse GATEWAY_INGEST_WORKERS (bounded ingest executor size)."""
    source = os.environ.get(INGEST_WORKERS_ENV) if raw is None else raw
    if not source or not source.strip():
        return DEFAULT_INGEST_WORKERS
    try:
        value = int(source)
    except ValueError:
        return DEFAULT_INGEST_WORKERS
    return value if value >= 1 else DEFAULT_INGEST_WORKERS


INGEST_EXECUTOR = ThreadPoolExecutor(
    max_workers=ingest_workers(),
    thread_name_prefix="pagepocket-ingest",
)


async def run_ingest(func, *args, **kwargs):
    """Await ``func(*args, **kwargs)`` on the bounded ingest executor.

    Mirrors ``starlette.concurrency.run_in_threadpool`` (kwargs/return
    passthrough) but dispatches to the dedicated pool instead of the shared
    AnyIO worker pool.
    """
    if kwargs:
        func = functools.partial(func, **kwargs)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(INGEST_EXECUTOR, func, *args)
