"""ASGI middleware that adds security hardening headers to all responses."""

from starlette.datastructures import MutableHeaders


class SecurityHeadersMiddleware:
    """Strip Server header and add security response headers.

    Headers added:
      - X-Content-Type-Options: nosniff
      - X-Frame-Options: DENY
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(raw=message["headers"])
                headers["x-content-type-options"] = "nosniff"
                headers["x-frame-options"] = "DENY"
                # Strip the Server header
                if "server" in headers:
                    del headers["server"]
            await send(message)

        await self.app(scope, receive, send_with_headers)
