"""Async SQLAlchemy database engine, session factory, and initialization."""

import asyncio
import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

logger = logging.getLogger(__name__)

# Async engine configured for aiomysql with InnoDB and utf8mb4
engine = create_async_engine(
    settings.mysql_connection_string,
    pool_size=10,
    max_overflow=20,
    pool_recycle=3600,
    pool_pre_ping=True,
    echo=False,
)

# Async session factory
async_session = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that yields an async database session."""
    async with async_session() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


@asynccontextmanager
async def async_session_factory():
    """Return a new async session context manager for use outside FastAPI.

    Used by background tasks (e.g. ZIP assembly) that need their own
    database session outside the request lifecycle.

    Unlike the raw async_session() context manager, this wrapper
    auto-commits on clean exit and rolls back on exception — matching
    the behaviour of the get_db() FastAPI dependency.
    """
    async with async_session() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


def log_pool_status() -> None:
    """Log current connection pool metrics for diagnostics.

    Reports pool_size, checked_out, and overflow at DEBUG level.
    Logs at WARNING when checked_out exceeds 80% of total capacity.
    """
    pool = engine.sync_engine.pool
    size = pool.size()
    checked_out = pool.checkedout()
    overflow = pool.overflow()
    max_overflow = pool._max_overflow
    total_capacity = size + max_overflow

    logger.debug(
        "Connection pool: size=%d, checked_out=%d, overflow=%d",
        size,
        checked_out,
        overflow,
    )

    if total_capacity > 0 and checked_out >= total_capacity * 0.8:
        logger.warning(
            "Connection pool near exhaustion: checked_out=%d/%d (80%% threshold)",
            checked_out,
            total_capacity,
        )


async def init_db() -> None:
    """Run Alembic migrations to ensure database schema is up to date.

    Alembic is the sole schema management tool — create_all() is NOT used
    alongside Alembic to avoid 'unmanaged table' conflicts.
    """
    from alembic import command
    from alembic.config import Config

    alembic_cfg = Config()
    alembic_cfg.set_main_option("script_location", "app/db/migrations")
    alembic_cfg.set_main_option(
        "sqlalchemy.url", settings.mysql_connection_string
    )

    logger.info("Running Alembic migrations (upgrade head)...")
    await asyncio.to_thread(command.upgrade, alembic_cfg, "head")
    logger.info("Alembic migrations complete.")
