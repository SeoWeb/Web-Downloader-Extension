"""Shared test fixtures for real-ORM (SQLite) route/service tests.

The suite historically tests route handlers with mock AsyncSessions. The
regression tests for harden-backend-security-and-ops (filename-map merge
persistence 3.3, finalize race 3.4, cloud binding 3.1, API-key hashing 7.5,
orphan-client cleanup 6.4) need actual SQLAlchemy change tracking, so they
run against an in-file SQLite database via aiosqlite.

aiosqlite is a test-only dependency (pip install aiosqlite).
"""

import os
import sys

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

# Make the app package importable and avoid creating the production MySQL
# engine side effects when only model metadata is needed.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest_asyncio.fixture
async def sqlite_db(tmp_path):
    """Yield (engine, session_factory) backed by a per-test SQLite database."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/test.db")

    from app.models import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield engine, factory
    finally:
        await engine.dispose()
