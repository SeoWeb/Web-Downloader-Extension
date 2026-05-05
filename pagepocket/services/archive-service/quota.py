"""Quota enforcement for page ingestion."""

from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from models import UserQuota, PLAN_LIMITS


def check_and_reserve(session, user_id: str, plan: str, request_size: int) -> str | None:
    """Check if user has quota and reserve it. Returns error message or None.

    Uses SELECT ... FOR UPDATE to prevent concurrent races.
    """
    limits = PLAN_LIMITS.get(plan, PLAN_LIMITS["free"])

    quota = session.execute(
        select(UserQuota).where(UserQuota.user_id == user_id).with_for_update()
    ).scalar_one_or_none()

    now = datetime.now(timezone.utc)

    if quota is None:
        quota = UserQuota(
            user_id=user_id,
            pages_this_month=0,
            total_bytes=0,
            quota_reset_at=now + timedelta(days=30),
        )
        session.add(quota)
        session.flush()

    # Monthly rollover
    if quota.quota_reset_at < now:
        quota.pages_this_month = 0
        quota.quota_reset_at = now + timedelta(days=30)

    # Check page limit
    if quota.pages_this_month >= limits["pages_per_month"]:
        return "Monthly page limit reached"

    # Check byte limit
    if quota.total_bytes + request_size > limits["max_bytes"]:
        return "Storage limit reached"

    return None
