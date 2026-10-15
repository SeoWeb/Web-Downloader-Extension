"""Structured-logging setup for the monolith (7.6).

Call :func:`configure_logging` once at startup. Level comes from ``LOG_LEVEL``
(default ``INFO``); ``LOG_FORMAT=json`` switches to one-JSON-object-per-line
output for log shippers. Mirrors ``pagepocket/shared/logging_config.py`` so
both backends log in the same shapes.
"""

import json
import logging
import os

_CONFIGURED = False

_DEFAULT_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


class JsonLogFormatter(logging.Formatter):
    """One JSON object per record — minimal, shipper-friendly fields."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging() -> None:
    """Configure the root logger once; safe to call repeatedly."""
    global _CONFIGURED
    if _CONFIGURED:
        return

    level_name = (os.environ.get("LOG_LEVEL") or "INFO").strip().upper()
    level = getattr(logging, level_name, logging.INFO)
    if level_name not in ("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG", "NOTSET"):
        level = logging.INFO

    handler = logging.StreamHandler()
    if (os.environ.get("LOG_FORMAT") or "").strip().lower() == "json":
        handler.setFormatter(JsonLogFormatter())
    else:
        handler.setFormatter(logging.Formatter(_DEFAULT_FORMAT))

    # force=True replaces any prior root handlers so the configured
    # level/format actually applies regardless of import order.
    logging.basicConfig(level=level, handlers=[handler], force=True)
    _CONFIGURED = True
