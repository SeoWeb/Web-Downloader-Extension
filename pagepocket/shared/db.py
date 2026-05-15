"""SQLAlchemy database session helper."""

import os
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase


class Base(DeclarativeBase):
    pass


def get_engine(db_url: str | None = None, auto_create: bool = True):
    url = db_url or os.environ["DB_URL"]
    engine = create_engine(url, pool_pre_ping=True, pool_recycle=3600)
    if auto_create and os.environ.get("MTLS_ENABLED", "false").lower() != "true":
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
