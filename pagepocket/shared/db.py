"""SQLAlchemy database session helper."""

import logging
import os
import time
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import DeclarativeBase, sessionmaker

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


def _is_transient_connect_error(exc: OperationalError) -> bool:
    """True ONLY when the DB server exists but is not accepting connections yet.

    Deliberately narrow so real configuration errors still fail fast: bad
    credentials (pymysql 1045 Access denied), unknown host (2005) and every
    other error are NOT retried. Only pymysql's "can't connect" codes
    (2003 TCP / 2002 socket) and an underlying ConnectionRefusedError — the
    fresh-volume boot race — qualify.
    """
    orig = getattr(exc, "orig", None)
    args = getattr(orig, "args", ()) or ()
    if args and args[0] in (2002, 2003):
        return True
    for cause in (getattr(orig, "__cause__", None), getattr(orig, "__context__", None)):
        if isinstance(cause, ConnectionRefusedError):
            return True
    return False


def _create_all_with_retry(engine, attempts: int, backoff_seconds: float) -> None:
    """Run ``Base.metadata.create_all`` with bounded connect-retry/backoff.

    Every service's boot path calls this from its servicer constructor, so a
    transient "MySQL not listening yet" at startup used to crash the whole
    container (exit 1, no restart policy) instead of riding out the few
    seconds until mysqld accepts TCP connections.

    Bounded: after ``attempts`` tries the last error is re-raised loudly —
    this only waits out the boot race, it never spins forever.
    """
    last_exc: OperationalError | None = None
    for attempt in range(1, attempts + 1):
        try:
            Base.metadata.create_all(engine)
            if attempt > 1:
                logger.info("db: MySQL accepted connections after %d attempts — schema ready", attempt)
            return
        except OperationalError as exc:
            if not _is_transient_connect_error(exc):
                raise  # e.g. Access denied (bad credentials) — config error, fail fast
            last_exc = exc
            if attempt == attempts:
                break
            if attempt == 1 or attempt % 5 == 0:
                logger.warning(
                    "db: MySQL not accepting connections yet (attempt %d/%d) — retrying in %.1fs",
                    attempt,
                    attempts,
                    backoff_seconds,
                )
            time.sleep(backoff_seconds)
    raise RuntimeError(
        f"db: MySQL not accepting connections after {attempts} attempts "
        f"({backoff_seconds:.1f}s backoff each) — giving up; is the DB container running?"
    ) from last_exc


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

    When create_all runs it opens a live connection, so it is wrapped in a
    bounded connect-retry (fresh-volume boot race: mysql's healthcheck passes
    on its socket-only init server before TCP is up; see
    _create_all_with_retry). Tune via DB_CONNECT_ATTEMPTS (default 45) and
    DB_CONNECT_BACKOFF_SECONDS (default 1.0).
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
        attempts = int(os.environ.get("DB_CONNECT_ATTEMPTS", "45"))
        backoff = float(os.environ.get("DB_CONNECT_BACKOFF_SECONDS", "1.0"))
        _create_all_with_retry(engine, attempts, backoff)
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
