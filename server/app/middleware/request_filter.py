"""ASGI middleware that short-circuits requests to known bot-scan paths."""

import logging

from app.config import settings

logger = logging.getLogger(__name__)


class RequestFilterMiddleware:
    """Reject requests whose path matches a configurable list of bot-scan patterns.

    Matching requests receive an immediate 404 with no response body.
    Filtered requests are logged at DEBUG level to avoid log noise.
    """

    def __init__(self, app):
        self.app = app
        self._filtered_paths = tuple(settings.filtered_paths)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = scope.get("path", "")
            if any(path.startswith(p) or path == p.rstrip("/") for p in self._filtered_paths):
                logger.debug("Filtered bot-scan request: %s", path)
                await send({
                    "type": "http.response.start",
                    "status": 404,
                    "headers": [(b"content-length", b"0")],
                })
                await send({
                    "type": "http.response.body",
                    "body": b"",
                })
                return

        await self.app(scope, receive, send)
