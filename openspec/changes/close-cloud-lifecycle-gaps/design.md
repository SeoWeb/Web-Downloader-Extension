# Design — close-cloud-lifecycle-gaps

Evidence: file:line references verified 2026-10-16 on `pagepocket`. Four independent gaps, one change each small enough to review inline; no backend coupling.

## Decisions

### D1 — Unbind: mirror of the binding endpoint, same dependency

`DELETE /api/v1/cloud/link` reuses `get_current_client` (`server/app/api/dependencies.py:93-107`) — identical auth semantics to the binding flow (401 on missing/unknown key, no detail leak). It clears exactly the three binding columns written by `cloud_link` (`cloud.py:84-86`: `pagepocket_user_id`, `pagepocket_plan`, `pagepocket_linked_at`) and touches nothing else: the client row stays authenticable (`api_key`, `last_auth_at` intact) so the extension identity survives a PP logout. Idempotent by construction — unbound client → still 200 `{bound: false, api_version}` — so a retried logout never errors.
_Extension side:_ `clearServerBinding()` in `src/background/cloud-binding.ts` wraps `ServerClient` DELETE + `chrome.storage.session.remove("pagepocket_cloud_binding")` (`PAGEPOCKET_CLOUD_BINDING_KEY`, `src/types/authTypes.ts:51`), called fire-and-forget from `pagepocketStore.logout` (`src/stores/pagepocketStore.ts:98-109`). Server-side failure is logged and swallowed: logout must complete even if the monolith is down; the next successful `linkCloudAccount()` overwrites the stale binding anyway.
_Alternative considered:_ clearing the binding on re-register or on expiry cron — rejected: unbinding is an identity action tied to the user's logout intent, not to lifecycle hygiene.

### D2 — Federated delete: opt-in, binding-gated, locally authoritative (user decision 2026-10-16)

The user explicitly chose opt-in (checkbox, default OFF) over delete-everywhere semantics: a local delete must never silently destroy cloud data the user may still want. Mechanics on `delete_session` (`server/app/api/routes/sessions.py:440-472`):

- **Parameter:** `delete_cloud: bool = False` as a **query parameter**, not a JSON body. The existing DELETE route takes no body and the extension's `deleteSession` sends none; a query param keeps existing callers untouched, stays curl-able, and avoids FastAPI's optional-DELETE-body 422 pitfalls. (POST routes here use optional JSON bodies; DELETE does not — the query param matches the route's current style.)
- **Gate:** cloud delete runs only when `delete_cloud=true` AND `session.cloud_status == "success"` AND `session.cloud_page_id` is set AND `session.pagepocket_user_id == client.pagepocket_user_id`. The binding match is the ownership proof on the cloud side (same model as `cloud-push-authorization`): a client that unbound (D1) or re-bound to another account must not delete pages belonging to the old identity — it gets `{deleted: true, cloud: {deleted: false, reason: "binding_mismatch"}}` and the local delete still proceeds.
- **RPC:** `archive_client.py` has no `DeletePage` wrapper today (verified — only `push_to_archive`, `archive_client.py:234-356`). Add a thin sync `delete_page(user_id, page_id)` reusing `_get_stub()` (same mTLS channel/identity), a short deadline, and `NOT_FOUND → already-deleted success` mapping; the async route runs it via `asyncio.to_thread` like `cloud.py`'s `_verify`.
- **Failure isolation (hard rule):** the cloud RPC result is wrapped — any exception becomes `{deleted: false, reason: ...}` in the response body, never an HTTP error, never a rollback of the local deletion. Local session removal (files + row) is authoritative and happens first. No retry budget is spent on the cloud delete (single attempt; a follow-up manual delete is idempotent).
- **Response:** `{"deleted": true, "cloud": {"deleted": true} | {"deleted": false, "reason": "<not_requested|not_cloud|binding_mismatch|cloud_error>"}, "api_version": "v1"}`.
  _Extension side:_ `ServerClient.deleteSession(sessionId, opts?)` appends `?delete_cloud=true`; `server-storage-adapter.ts` `clear()` passes the option through; the panel shows the unchecked-by-default checkbox only for sessions with `cloud_status == "success"` (the status the extension already tracks per `cloud-via-server`).

### D3 — Asset-count parity: stat-only pre-flight, monolith's own knob

`push_to_archive` already does a byte pre-flight (`archive_client.py:265-279`) but not an asset-count gate — the gateway REST path rejects > `MAX_INGEST_ASSETS` (default 200, `validation.py:24-25`) deterministically, while the push path would ship 201+ assets to a 400-class rejection and burn the 3 × 600 s retry budget. Add the count check beside the byte check: `len(assets) > cap` → immediate deterministic `CloudPushResult` error, no proto built, no gRPC call, no retries. Semantics on the session: `cloud_status = "failed"` + `cloud_error`, session stays `ready` — identical to the existing pre-flight size failure.
_Config:_ the monolith uses pydantic-settings (`server/app/config.py`), not the gateway's env-module style — so it gets its own field `cloud_max_assets: int = 200` (env `CLOUD_MAX_ASSETS`). Reusing the literal name `MAX_INGEST_ASSETS` was rejected: the two caps live in different processes with different config systems; equal _defaults_ (200) carry the parity, and a monolith-specific knob avoids coupling gateway tuning to push tuning.

### D4 — Trusted-proxy drift alarm: derive, warn, never crash

The incident (`scripts/prod/README.md:212-219`): the bridge gateway was `172.19.0.1` while the compose default configured `172.18.0.1` — every request's peer fell outside `TRUSTED_PROXIES`, so XFF was distrusted and all users shared one 20/min auth bucket. Detection is cheap and dependency-free: parse `/proc/net/route`, find the interface owning the default route (`Destination 00000000`), decode the little-endian hex gateway column. Compare against `config.trusted_proxies()` (the same parsed list the limiter uses).

- **Placement:** gateway `main.py` runs module-level `enforce_startup_config()` (no FastAPI lifespan in this codebase) — the drift check joins it as a plain function in `config.py` (unit-testable without FastAPI, same pattern as the existing prod-config checks), invoked once at startup with the verdict stored in module state and handed to `build_health_router`.
- **Failure posture:** drift → `logger.error` structured line (derived IP, configured entries, remediation hint incl. `docker network inspect pagepocket_default --format '{{(index .IPAM.Config 0).Gateway}}'`) and **continue booting** — same fail-open philosophy as the limiter; an alarm must never take the gateway down. Unreadable `/proc/net/route` / no default route (bare-metal dev) → check skipped silently, verdict `ok`.
- **Health:** `GET /api/v1/health` gains `"trusted_proxies": "ok" | "drift"` next to `rate_limiter` (`health.py:15-22`) — the same verdict the log line carries, so orchestration can scrape it without parsing logs.

## Failure-isolation rules (summary)

1. **Unbind never blocks logout** — extension-side: network/server failure → log + proceed with logout; local state cleared regardless.
2. **Cloud delete never fails a local delete** — single attempt, no retries; every failure mode degrades to `cloud: {deleted: false, reason}` in a 200 response.
3. **Asset-cap rejection is deterministic** — no gRPC traffic, no retry consumption; the session remains locally usable (`ready`, cloud fields carry the error).
4. **Drift alarm warns, never crashes** — startup always completes; unknown topology raises no alarm.

## Scope guards

- **No backup/retention/rclone work** — explicitly out of scope (user decision 2026-10-16).
- **No automatic cloud deletes** — the checkbox defaults OFF everywhere; no batch/purge tooling for already-orphaned cloud pages (follow-up if demand appears).
- **No changes to the `POST /cloud/link` contract** — unbind is purely additive next to it.
- **No gateway limiter changes** — D4 only _detects and reports_ the drift that breaks the limiter's trust assumptions.
