## Why

The cloud lifecycle introduced by `harden-backend-security-and-ops` is one-directional: a PagePocket identity can be bound to an API-key client (`POST /api/v1/cloud/link`) but never unbound — PP logout clears only extension-side state (`src/stores/pagepocketStore.ts:98-109`), leaving `clients.pagepocket_user_id/_plan/_linked_at` set on the monolith. A finished cloud page can be created but not federated-deleted — deleting a server session (`server/app/api/routes/sessions.py:440-472`) removes only local files, so users who want a page gone from PagePocket must open the web app separately. And the server-side push path enforces a payload-size pre-flight but not the gateway's 200-asset cap, so an over-cap push burns its full 3 × 600 s retry budget on a rejection the REST path catches deterministically. Finally, the 2026-10-16 prod incident (actual bridge gateway `172.19.0.1` vs the configured `172.18.0.1` default, `scripts/prod/README.md:212-219`) silently collapsed every web user into one 20/min auth bucket — nothing detects that drift today.

## What Changes

**Unbind endpoint (monolith + extension)**

- `DELETE /api/v1/cloud/link`, authenticated by the same `X-API-Key` client dependency as the binding flow: clears `pagepocket_user_id`/`pagepocket_plan`/`pagepocket_linked_at` (keeps the API key and `last_auth_at`), idempotent (already-unbound → still 200), responds `{bound: false, api_version}`.
- Extension: `clearServerBinding()` in `src/background/cloud-binding.ts` is called from the PP logout flow; the `pagepocket_cloud_binding` session-storage state is cleared on success; failure is non-blocking (logout always completes).

**Opt-in federated delete (user decision 2026-10-16)**

- `DELETE /api/v1/sessions/{id}` accepts `delete_cloud` (query bool — matches the route's existing no-body style). When true AND the session's cloud push succeeded AND the calling client's binding still matches the session's cloud identity, the monolith calls `ArchiveService.DeletePage` via a new thin `delete_page()` in `server/app/services/archive_client.py` (same channel/mTLS/identity conventions as `push_to_archive` — no such wrapper exists today).
- Failure isolation: a cloud-delete failure NEVER fails the local delete (local removal is authoritative); the response reports the per-target outcome `{deleted: true, cloud: {deleted: true} | {deleted: false, reason}}`. A missing cloud page is idempotent success.
- Extension: the panel's delete path (`ServerClient.deleteSession` → `server-storage-adapter.ts` `clear()`) gains the opt-in; the UI shows a checkbox "Also remove from PagePocket" (default OFF) only for cloud-mode sessions (`cloud_status == "success"`).

**Asset-count parity (monolith push)**

- `push_to_archive` gains a stat-only pre-flight asset-count gate (before building/sending anything, no retry consumption) with its own monolith env knob `CLOUD_MAX_ASSETS` (default 200 — same default the gateway's `MAX_INGEST_ASSETS` enforces on REST ingest). Over-cap pushes surface through the existing cloud failure path: `cloud_status = "failed"` + `cloud_error`, session still ready for local download.

**Gateway trusted-proxy drift alarm**

- At startup the gateway derives the container's actual default-route gateway IP from `/proc/net/route` (no extra deps) and compares it against the configured `TRUSTED_PROXIES`; on drift it logs a loud structured error with an explicit remediation hint (incl. the `docker network inspect pagepocket_default` one-liner) but never crashes (fail-open, matching the limiter's philosophy).
- `GET /api/v1/health` reports the verdict as `"trusted_proxies": "ok" | "drift"` next to `rate_limiter`.

## Capabilities

### New Capabilities

- `gateway-proxy-trust`: startup detection of `TRUSTED_PROXIES` drift vs the container's real docker gateway IP — loud warn-never-crash alarm plus the `/api/v1/health` verdict.

### Modified Capabilities

- `cloud-push-authorization`: ADDED requirement — the unbind counterpart of the binding flow (server endpoint semantics + extension logout wiring).
- `cloud-via-server`: ADDED requirements — opt-in federated delete of cloud pages (server gating, failure isolation, idempotency, extension checkbox) and push pre-flight asset-count parity with the REST ingest cap.

## Impact

- **Code (monolith)**: `server/app/api/routes/cloud.py` (unbind endpoint), `server/app/api/routes/sessions.py` (delete_cloud param, cloud-delete wiring, response shape), `server/app/services/archive_client.py` (new `delete_page()`, asset-count pre-flight), `server/app/config.py` (`cloud_max_assets`), `server/tests/` (new regression tests).
- **Code (extension)**: `src/background/cloud-binding.ts` (`clearServerBinding()`), `src/stores/pagepocketStore.ts` (logout call), `src/background/server-client.ts` (`deleteSession` option), `src/background/storage/server-storage-adapter.ts` (pass-through), `src/sidepanel.tsx` + panel components (checkbox UI), tests.
- **Code (pagepocket gateway)**: `pagepocket/services/api-gateway/config.py` (gateway-IP derivation helper), `main.py` (startup check), `routers/health.py` (verdict field), gateway tests.
- **Ops/docs**: `scripts/prod/README.md` (drift-alarm note, `CLOUD_MAX_ASSETS`, verification curls — updated in the deploy-gated section).
- **Deploy coupling**: none between backends — all wire contracts are additive (new endpoint, optional query param, additive response fields). The monolith and gateway can deploy independently; the extension ships independently of both.
- **Out of scope (explicit)**: no backup/retention/rclone items; no automatic (non-opt-in) cloud deletes; no retroactive cleanup of already-orphaned cloud pages.
