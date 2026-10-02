"""Rate limiting middleware for FastAPI."""

import time
from collections import defaultdict

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, auth_limit: int = 20, authenticated_limit: int = 600, window: int = 60):
        super().__init__(app)
        self.auth_limit = auth_limit
        self.authenticated_limit = authenticated_limit
        self.window = window
        self._auth_counters: dict[str, list[float]] = defaultdict(list)
        self._user_counters: dict[str, list[float]] = defaultdict(list)

    def _check_limit(self, key: str, counters: dict, limit: int) -> bool:
        now = time.time()
        counters[key] = [t for t in counters[key] if now - t < self.window]
        if len(counters[key]) >= limit:
            return False
        counters[key].append(now)
        return True

    def _rate_limited(self):
        return JSONResponse(
            status_code=429,
            content={"detail": "Rate limit exceeded", "api_version": "v1"},
            headers={"Retry-After": str(self.window)},
        )

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Health check exempt
        if path == "/api/v1/health":
            return await call_next(request)

        # Auth routes: per-IP limit
        if path.startswith("/api/v1/auth/"):
            ip = request.client.host if request.client else "unknown"
            if not self._check_limit(f"auth:{ip}", self._auth_counters, self.auth_limit):
                return self._rate_limited()

        # Authenticated routes: per-user limit
        elif hasattr(request.state, "user_id"):
            if not self._check_limit(f"user:{request.state.user_id}", self._user_counters, self.authenticated_limit):
                return self._rate_limited()

        return await call_next(request)
