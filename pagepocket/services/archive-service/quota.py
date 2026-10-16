"""Quota enforcement for page ingestion — reserve-then-confirm (2.14).

The quota row lock must never be held across the R2 upload phase (a second
concurrent ingest of the same user would hit the InnoDB 50 s lock-wait
timeout, design note e). The flow is therefore:

1. ``reserve_quota`` — short ``FOR UPDATE`` transaction: check limits and
   increment the counters (the reservation); the caller commits immediately,
   releasing the lock before any upload starts.
2. Upload runs lock-free.
3. ``confirm_quota`` — second short ``FOR UPDATE`` transaction: re-check the
   limits (concurrent ingests may have consumed the budget while this ingest
   was uploading) and either keep the reservation or refund it in the same
   locked transaction.

``refund_quota`` releases a reservation after a failed or lost ingest.

All RESOURCE_EXHAUSTED detail strings carry the machine-readable
``exhausted:<kind>|`` prefix (D9) ahead of the unchanged legacy human message,
which the monolith's fallback matching still relies on.
"""

from datetime import UTC, datetime, timedelta

from models import PLAN_LIMITS, UserQuota
from quota_markers import EXHAUSTED_PREFIX, KIND_QUOTA, KIND_SIZE
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError


def _exhausted(kind: str, message: str) -> str:
    """Build a RESOURCE_EXHAUSTED detail: ``exhausted:<kind>|<human message>``."""
    return f"{EXHAUSTED_PREFIX}{kind}|{message}"


def _locked_quota(session, user_id: str) -> UserQuota:
    """Fetch the user's quota row ``FOR UPDATE``, creating and rolling it forward."""
    quota = session.execute(
        select(UserQuota).where(UserQuota.user_id == user_id).with_for_update()
    ).scalar_one_or_none()

    now = datetime.now(UTC)
    now_naive = now.replace(tzinfo=None)

    if quota is None:
        quota = UserQuota(
            user_id=user_id,
            pages_this_month=0,
            total_bytes=0,
            quota_reset_at=now_naive + timedelta(days=30),
        )
        try:
            # Savepoint: a concurrent first ingest of the same user can win
            # the INSERT between our SELECT and ours — adopt their row
            # instead of surfacing a UNIQUE-constraint UNKNOWN.
            with session.begin_nested():
                session.add(quota)
        except IntegrityError:
            quota = session.execute(
                select(UserQuota).where(UserQuota.user_id == user_id).with_for_update()
            ).scalar_one()

    # Normalize to naive UTC: the DateTime column is timezone-naive, but
    # values set programmatically (or legacy rows) may carry tzinfo.
    reset_at = quota.quota_reset_at
    if reset_at.tzinfo is not None:
        reset_at = reset_at.astimezone(UTC).replace(tzinfo=None)

    # Monthly rollover
    if reset_at < now_naive:
        quota.pages_this_month = 0
        quota.quota_reset_at = now_naive + timedelta(days=30)

    return quota


def reserve_quota(session, user_id: str, plan: str, request_size: int) -> str | None:
    """Reserve one ingest against the user's quota (check + increment).

    The caller MUST run this in a short transaction committed before any R2
    upload so the ``FOR UPDATE`` row lock is released before uploads begin
    (2.14). Returns a prefixed ``exhausted:<kind>|<message>`` detail string on
    quota exhaustion (counters untouched) or None when the reservation was
    applied.
    """
    limits = PLAN_LIMITS.get(plan, PLAN_LIMITS["free"])
    quota = _locked_quota(session, user_id)

    # Check page limit
    if quota.pages_this_month >= limits["pages_per_month"]:
        return _exhausted(KIND_QUOTA, "Monthly page limit reached")

    # Check byte limit
    if quota.total_bytes + request_size > limits["max_bytes"]:
        return _exhausted(KIND_SIZE, "Storage limit reached")

    quota.pages_this_month += 1
    quota.total_bytes += request_size
    return None


def confirm_quota(session, user_id: str, plan: str, request_size: int) -> str | None:
    """Re-check quota after the lock-free upload and confirm the reservation.

    Concurrent ingests may have consumed the remaining budget while this
    ingest was uploading; if the totals now exceed the plan limits, this
    ingest's reservation is refunded inside the same locked transaction and
    the prefixed error is returned. Caller commits either way.
    """
    limits = PLAN_LIMITS.get(plan, PLAN_LIMITS["free"])
    quota = _locked_quota(session, user_id)

    over_pages = quota.pages_this_month > limits["pages_per_month"]
    over_bytes = quota.total_bytes > limits["max_bytes"]

    if not (over_pages or over_bytes):
        return None

    if over_pages:
        quota.pages_this_month = max(0, quota.pages_this_month - 1)
        return _exhausted(KIND_QUOTA, "Monthly page limit reached")
    quota.total_bytes = max(0, quota.total_bytes - request_size)
    return _exhausted(KIND_SIZE, "Storage limit reached")


def refund_quota(session, user_id: str, request_size: int) -> None:
    """Release a reservation after a failed/lost ingest (floored at zero)."""
    quota = _locked_quota(session, user_id)
    quota.pages_this_month = max(0, quota.pages_this_month - 1)
    quota.total_bytes = max(0, quota.total_bytes - request_size)
