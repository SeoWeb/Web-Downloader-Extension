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
