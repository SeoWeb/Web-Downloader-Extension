# Tasks — close-cloud-lifecycle-gaps

## 1. Server (monolith) — cloud unbind endpoint

- [x] 1.1 Add `DELETE /api/v1/cloud/link` in `server/app/api/routes/cloud.py`: `get_current_client` auth (same as the binding flow), clear `pagepocket_user_id`/`pagepocket_plan`/`pagepocket_linked_at` in one commit, keep `api_key`/`last_auth_at`, return `{"bound": false, "api_version": "v1"}` — idempotent for an already-unbound client (no 404/409 path)
- [x] 1.2 Add unit tests in `server/tests/`: unbind clears exactly the three columns and the client still authenticates afterwards; unbound-client unbind returns 200 `{bound: false}`; missing/unknown `X-API-Key` → 401 with no row modification

## 2. Server (monolith) — federated delete + asset-count parity

- [x] 2.1 Add the thin sync `delete_page(user_id, page_id)` wrapper in `server/app/services/archive_client.py` reusing `_get_stub()` (same mTLS channel/identity conventions as `push_to_archive`), a short unary deadline, and `NOT_FOUND → already-deleted success` mapping
- [x] 2.2 Extend `delete_session` in `server/app/api/routes/sessions.py` with the `delete_cloud: bool = False` query parameter; gate the cloud delete on `delete_cloud AND cloud_status == "success" AND cloud_page_id AND session.pagepocket_user_id == client.pagepocket_user_id`; run the blocking RPC via `asyncio.to_thread` (mirroring `cloud.py`'s `_verify`); single attempt, exceptions caught — never fail or roll back the local delete
- [x] 2.3 Change the delete response to the per-target outcome shape `{"deleted": true, "cloud": {"deleted": true} | {"deleted": false, "reason": "<not_requested|not_cloud|binding_mismatch|cloud_error>"}, "api_version": "v1"}` in `server/app/api/routes/sessions.py`
- [x] 2.4 Add `cloud_max_assets: int = 200` to `server/app/config.py` (env `CLOUD_MAX_ASSETS`) and the stat-only asset-count pre-flight beside the byte check in `push_to_archive` (`server/app/services/archive_client.py`) — deterministic `CloudPushResult` error before any proto build/gRPC call, no retry consumption; `cloud_status = "failed"` + `cloud_error` on the session, session stays `ready`
- [x] 2.5 Add unit tests in `server/tests/`: opt-in delete path calls `delete_page` with the session's `cloud_page_id`; default (no param) makes no cloud RPC; binding mismatch / non-cloud session skip with the right `reason`; DeletePage exception → 200 with `cloud: {deleted: false}` while the local session is gone; missing cloud page → `{deleted: true}`; asset-count pre-flight trips at `cloud_max_assets + 1` without touching the stub and passes at the cap

## 3. Extension — unbind on logout + opt-in cloud delete UI

- [x] 3.1 Add `clearServerBinding()` in `src/background/cloud-binding.ts`: `ServerClient` DELETE `/api/v1/cloud/link`, then `chrome.storage.session.remove("pagepocket_cloud_binding")` only on success; network/server failure logged and swallowed
- [x] 3.2 Wire `clearServerBinding()` into the PP logout flow in `src/stores/pagepocketStore.ts` (`logout`, fire-and-forget, never blocks or fails logout) alongside the existing local `clearCloudBinding()`
- [x] 3.3 Add the optional `{ deleteCloud?: boolean }` param to `ServerClient.deleteSession` in `src/background/server-client.ts` (appends `?delete_cloud=true`) and pass it through `clear()` in `src/background/storage/server-storage-adapter.ts`
- [x] 3.4 Add the delete-confirmation checkbox "Also remove from PagePocket" (default OFF) in the panel delete flow (`src/sidepanel.tsx` + components), rendered only for cloud-mode sessions with `cloud_status == "success"`; on confirm, thread the option to the delete call
- [x] 3.5 Add vitest unit tests: `clearServerBinding` success clears the storage key / failure leaves logout unaffected; `deleteSession` omits the param by default and sends `delete_cloud=true` when asked; checkbox renders only for `cloud_status == "success"` and defaults unchecked

## 4. PagePocket gateway — trusted-proxy drift alarm

- [x] 4.1 Add a `/proc/net/route` default-route gateway-IP derivation helper (decode the little-endian hex gateway of the interface owning `Destination 00000000`) in `pagepocket/services/api-gateway/config.py` — plain function, no new dependencies, injectable route-table content for tests
- [x] 4.2 Add the drift check (derived gateway IP vs `config.trusted_proxies()`) invoked at startup in `pagepocket/services/api-gateway/main.py` next to `enforce_startup_config()`: on drift, `logger.error` a structured line carrying both values plus the remediation hint (`docker network inspect pagepocket_default --format '{{(index .IPAM.Config 0).Gateway}}'`) and continue booting — never raise; unreadable/absent route table → silent skip, verdict `ok`
- [x] 4.3 Expose the verdict in `GET /api/v1/health` (`pagepocket/services/api-gateway/routers/health.py`) as `"trusted_proxies": "ok" | "drift"` next to `rate_limiter`, threading the check result from `main.py` into `build_health_router`
- [x] 4.4 Add gateway unit tests: covered → no log + `ok`; uncovered (172.19.0.1 vs configured 172.18.0.1, the real incident shape) → error log with remediation hint + `drift` + startup proceeds; unparseable route table → no alarm

## 5. Tests & docs (local)

- [x] 5.1 Run the monolith suite green: `cd server && python3 -m pytest tests -q` (new unbind / federated-delete / asset-cap tests included)
- [x] 5.2 Run the gateway suite green (drift-alarm + health-field tests) and the extension suite green (`pnpm test`) for the touched stores/client/adapter/UI logic
- [x] 5.3 Confirm no other caller of `DELETE /api/v1/sessions/{id}` depends on the old response shape (grep `server/`, `src/`, docs) and update the API docs/README where the delete contract is described

## 6. Final verification

- [x] 6.1 Walk every scenario in this change's spec deltas and confirm an automated test or documented manual check exists
- [x] 6.2 Run `openspec validate --change close-cloud-lifecycle-gaps` until valid and confirm `openspec list` shows exactly this one active change
- [x] 6.3 Confirm no task above mutated production (no host SSH writes, no compose changes applied, no `scripts/prod/` script executed)

## 7. Deployment-gated (user-ordered — executed only via the gated deploy workflow)

- [x] 7.1 DEPLOY-GATED (user-ordered): deploy the monolith + gateway via the CI-gated workflow (`scripts/prod/README.md` runbook) and confirm both health gates pass
- [x] 7.2 DEPLOY-GATED (user-ordered): verify unbind with curl — bind a scratch client, `curl -X DELETE https://server.pagepocket.app/api/v1/cloud/link -H "X-API-Key: …"` → 200 `{bound: false}`; repeat (idempotent 200); confirm `POST /api/v1/sessions` for that client no longer pushes to cloud
- [x] 7.3 DEPLOY-GATED (user-ordered): verify federated delete E2E — push a real cloud page from the extension, delete the server session with the checkbox ON, confirm the page disappears from the PagePocket library and the response reports `cloud: {deleted: true}`; repeat with checkbox OFF and confirm the cloud page survives
- [x] 7.4 DEPLOY-GATED (user-ordered): verify the asset-cap parity by pushing a >200-asset page → session `ready` with `cloud_status: failed` + asset-count `cloud_error`, no retry stall in the logs
- [x] 7.5 DEPLOY-GATED (user-ordered): verify the drift alarm on a scratch run — temporarily set `TRUSTED_PROXIES` to a wrong gateway IP, recreate the gateway, confirm the error log + `health.trusted_proxies: "drift"` (and that the gateway still boots), then restore the correct value and re-verify bucketing per the runbook's 20/min procedure
- [x] 7.6 DEPLOY-GATED (user-ordered): update `scripts/prod/README.md` — the drift-alarm log signature + remediation one-liner, the `CLOUD_MAX_ASSETS` knob, and the unbind/delete_cloud verification curls, recording the evidence from 7.2–7.5
