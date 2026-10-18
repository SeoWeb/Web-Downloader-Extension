## Why

Production diagnosis (2026-10-16/18, all findings verified with file:line) shows archived pages rendering text-only despite being fully stored: page `5ecce3ab-7b6c-4a8c-a467-6a06ff791f37` (user `6b8136ae-a772-4e16-93ab-3518d609c754`) has all 103 assets in R2 (`{user}/{page}/assets/…`, verified via `list_objects_v2`), yet the viewer at `app.pagepocket.app` renders only text. The sandboxed viewer iframe (`IFRAME_SANDBOX = "allow-popups allow-forms"` — `allow-same-origin` dropped in `4895059`) gives archived documents an opaque origin (`null`); every subresource request they make is CORS-mode (webfonts always, plus preserved `crossorigin` tags from source pages), and NO component emits `Access-Control-Allow-Origin` — the proxies emit only sandbox headers, and the gateway's CORS allow-list can never contain `null` (wildcards are dropped by design). The browser therefore blocks every css/js/img/font load. In the same session, share-link creation fails: both the UI dialog and a direct `curl POST /api/pp/share` return `{"error":"Proxied route not allowed"}` because the BFF allow-list regex requires a path separator after the route family while the gateway exposes `POST ""`/`GET ""` at the `/share` root. Separately, the monolith's `sessions.resources_received` column is provably stale (live probe 2026-10-18: 103 resource rows, column = 0 — the upload route works end-to-end but the column was abandoned by the documented per-upload deadlock fix), misleading ops probes. And in the extension, a hung resource upload is a single-attempt permanent failure (timeout aborts are classified as non-retryable), terminal upload failures are silent, and a completed download hides failed-upload counts.

## What Changes

**A — BFF file-route CORS for the opaque-origin viewer (`pagepocket/frontend`)**

- The two archived-file proxies — `/api/pp/[...path]` when the upstream is the archive page-file route (paths containing `/f/`) and `/api/sc/[token]/[...path]` — echo the request `Origin` header (including the literal `null`) into `Access-Control-Allow-Origin` on file responses, and add `Access-Control-Allow-Credentials: true` and `Vary: Origin`.
- Non-file API routes gain NO ACAO; requests without an `Origin` gain none. The gateway is untouched (its allow-list can never match `null`; fixing there is out of scope by design).

**B — Share-proxy allow-list (`pagepocket/frontend`)**

- `ALLOWED_UPSTREAM` regex becomes `/^\/api\/v1\/(archive|library|search|share|auth)(\/|$)/` so bare family roots (`POST /api/v1/share`, `GET /api/v1/share?page_id=…`) pass the BFF. Traversal safety (`isSafeSegment`) is unchanged.

**C — Monolith `resources_received` integrity (`server/`)**

- The session-row column is reconciled at finalize time (single UPDATE beside the existing transition — NOT per-upload increments, which the repo's documented deadlock fix removed), and finalize emits a loud structured warning when `resources_discovered > resources_received` (both counts + session id). Visibility, not refusal: finalize semantics are unchanged, and the `/status` endpoint's live aggregates remain the API truth (the extension resume path reads via the status API and is already correct).

**D — Extension upload robustness (`src/`)**

1. `AbortSignal.timeout()` aborts (DOMException `TimeoutError`) are classified retryable by the upload queue; user cancellation (`AbortError`) stays terminal.
2. Every terminal failure class logs exactly one structured warn/error (authentication, abort/cancel, 413 session-full fail-all once, retries exhausted) — today all four are silent.
3. `failedCount` is propagated into the `status.complete` payload and panel state, so "completed with N failed uploads" is visible in the UI.
4. The resume task manifest (path, originalUrl, contentType, size, refetch URL) is persisted to `chrome.storage.session` keyed per download (no blobs), so the existing SW-death resume path can drain into a fresh upload queue; a test proves resume actually produces uploads.

## Capabilities

### Modified Capabilities

- `archived-html-serving`: ADDED requirement — opaque-origin viewer CORS on the two archived-file proxies (echo `Origin` incl. literal `null`, credentials, `Vary: Origin`; file responses only).
- `archived-file-proxy`: MODIFIED requirement "Route Allow-List and Traversal Rejection" — the composed-path pattern admits bare route families (`(\/|$)`), unblocking `POST/GET /api/v1/share` through the BFF.
- `server-api`: MODIFIED requirements "Resource File Upload" (counter semantics reconciled with the deadlock fix: no per-upload session-row updates; live aggregate is authoritative) and "Session Finalization" (finalize-time column reconciliation + loud discovery/received deficit warning, never a refusal).
- `upload-timeouts`: MODIFIED requirement "Resource upload request timeout" — timeout aborts (`DOMException` `TimeoutError`) are explicitly classified retryable, distinct from terminal user-cancellation `AbortError`.
- `download-ux-feedback`: ADDED requirements — terminal upload failures are logged (once per class, no spam) and completed downloads report failed-upload counts in the `status.complete` payload + panel state.
- `server-session-resume`: MODIFIED requirement "Server session resume from checkpoint" — the task manifest is complete (size added) and keyed per download in `chrome.storage.session` (blobs never persisted), so post-SW-death resume drains into a fresh queue.

## Impact

- **Code (pagepocket frontend)**: `pagepocket/frontend/src/app/api/pp/[...path]/route.ts` (ACAO on file responses, allow-list regex), `pagepocket/frontend/src/app/api/sc/[token]/[...path]/route.ts` (ACAO), `src/lib/serving-headers.ts` (shared CORS header helper), `route.test.ts` files, `src/lib/client-api.ts` (no code change expected — unblocked by B), `src/sidepanel/server-mode-state.ts` + completion components (failedCount display).
- **Code (monolith)**: `server/app/api/routes/sessions.py` (finalize reconciliation + integrity warning), `server/tests/` (regression tests).
- **Code (extension)**: `src/background/upload-queue.ts` (TimeoutError classification, terminal-failure logging), `src/background/download-core.ts` (failedCount in status.complete, per-download checkpoint manifest), `src/background/download-checkpoint.ts` (per-download keying, size field), `tests/unit/*` (four new test groups).
- **Deploy coupling**: none server-side — the gateway is untouched, no wire contract changes; the frontend deploy (`deploy-frontend`, path filter `pagepocket/frontend/**`) is independent; the monolith is manual-rebuild only (`server/**` is in no deploy filter — `scripts/prod/README.md` §13 gotcha); the extension ships independently (user rebuild + reload).
- **Out of scope**: gateway CORS changes (by design — allow-list can never contain `null`); any relaxation of the iframe sandbox (`allow-same-origin` stays dropped); persisting upload blobs to storage; retroactive backfill of historical stale `resources_received` rows.
