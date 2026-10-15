"""SQLAlchemy database session helper."""

import os
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker


class Base(DeclarativeBase):
    pass


def get_engine(db_url: str | None = None, auto_create: bool | None = None):
    """Create the service's SQLAlchemy engine.

    Schema-creation policy (harden-backend-security-and-ops 5.6): Alembic is
    the single authoritative mechanism in every environment;
    ``Base.metadata.create_all`` is a dev/test-only convenience controlled by
    an explicit ``AUTO_CREATE`` env var and is NOT coupled to ``MTLS_ENABLED``.

    Resolution order:
      1. explicit ``auto_create`` argument (callers/tests);
      2. ``AUTO_CREATE`` env var ("1/true/yes/on" — prod compose override
         forces "false" so prod schema is never shaped implicitly);
      3. legacy fallback when AUTO_CREATE is unset: enabled while
         ``MTLS_ENABLED`` is not "true", preserving local dev behavior.
    """
    url = db_url or os.environ["DB_URL"]
    engine = create_engine(url, pool_pre_ping=True, pool_recycle=3600)
    env_flag = os.environ.get("AUTO_CREATE")
    if env_flag is not None:
        should_create = env_flag.strip().lower() in ("1", "true", "yes", "on")
    elif auto_create is not None:
        should_create = auto_create
    else:
        should_create = os.environ.get("MTLS_ENABLED", "false").lower() != "true"
    if should_create:
        Base.metadata.create_all(engine)
    return engine


def get_session_factory(engine=None):
    if engine is None:
        engine = get_engine()
    return sessionmaker(bind=engine)


@contextmanager
def db_session(engine=None):
    """Context manager that yields a SQLAlchemy Session and auto-commits/rollbacks."""
    Session = get_session_factory(engine)
    session = Session()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
