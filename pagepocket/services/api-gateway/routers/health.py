"""Health endpoint with live dependency signals."""

from fastapi import APIRouter


def build_health_router(limiter, trusted_proxies_verdict: str = "ok") -> APIRouter:
    """Build the health router reporting the rate limiter state.

    ``limiter`` is the middleware's ``RedisRateLimiter`` instance; ``healthy``
    flips to False when Redis is unreachable (limiter fails open, health
    reports ``degraded`` per the rate-limiting spec).

    ``trusted_proxies_verdict`` is the startup drift-alarm verdict (D4,
    "ok" | "drift") handed over from main.py's module state. Callers that
    omit it get "ok" — unknown topology never raises a false alarm.
    """
    router = APIRouter()

    @router.get("/api/v1/health")
    async def health():
        return {
            "status": "ok",
            "api_version": "v1",
            "rate_limiter": "ok" if limiter.healthy else "degraded",
            "trusted_proxies": trusted_proxies_verdict,
        }

    return router
