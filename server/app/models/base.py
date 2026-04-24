"""SQLAlchemy declarative base for all database models."""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Base class for all ORM models. Configured for MySQL InnoDB with utf8mb4."""

    pass
