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

**E — Signed asset tokens for the credential-less viewer (`pagepocket/frontend` + `pagepocket/services`)**

CORS echoing (A) is necessary but not sufficient: CORS-mode subresource loads cannot send cookies AT ALL (by fetch spec), so the cookie-authenticated BFF file route still answers 401 and the browser masks it as a CORS error (2026-10-19 prod: page `17860421` has 103/103 assets in R2 yet the viewer still renders text-only; a cookie-less file request returns 401 with no ACAO). The BFF now mints an HMAC "asset token" bound to (page_id, user_id, exp-bucket) — `payload_b64url.mac_b64url`, HMAC-SHA256 under a DEDICATED `ASSET_TOKEN_SECRET` (never `JWT_SECRET`), expiry `e = (floor(now/TTL)+2)*TTL` with `ASSET_TOKEN_TTL_SECONDS` defaulting to 604800 — and injects it as a PATH segment (`…/f/X` → `…/f/at/{token}/X`) into the served archived HTML: only `text/html` bodies, only THIS page's `f`-URLs (absolute app URLs and root-relative alike), idempotently, never touching css/js/img bytes (relative `url()` refs inside CSS inherit the token segment automatically). Rewritten HTML carries `Cache-Control: private, no-cache` so fresh tokens are picked up each view; the gateway accepts cookie OR valid token on the archive file route. With `ASSET_TOKEN_SECRET` unset/empty the feature is OFF and HTML is served byte-identical to today.

**F — Monolith archived-page stylesheet/script references (`server/`)**

- The ZIP assembler seeds the HTML-conversion filename map from the stored `resources` rows (`original_url → local_path`) in addition to the extension's image-only map, so stylesheet/script/preload URLs resolve to the exact stored asset paths (`styles/wp-content/…/<name>_<hash8>.css`) instead of the legacy `styles/<basename>.css` fallback that 404'd on every WordPress-style page.

**G — Extension sends absolute source URLs (`src/`)**

- The css/js/documents handlers pass the resolved absolute source URL (query string included) as the 4th `addFile` argument and the uploaded session filename map now covers all four asset categories (images first, never clobbered), so `resources.original_url` no longer equals `local_path` and fix F's server-side map seed actually hits — repairing the re-download 404s that fix F alone could not, because absolute URLs never reached the server (server-side derivation from the stored path is impossible: the query string only survives as a one-way `_hash8` suffix).

## Capabilities

### Modified Capabilities

- `archived-html-serving`: ADDED requirement — opaque-origin viewer CORS on the two archived-file proxies (echo `Origin` incl. literal `null`, credentials, `Vary: Origin`; file responses only). ADDED requirement "Credential-less archived asset access" (fix E) — sandboxed viewer subresource loads succeed without cookies via signed asset tokens that are page-and-owner-bound and expire; token URLs are accepted by the gateway on the archive file route. ADDED requirement "Stylesheet and script references resolve to stored assets" (fix F) — assembler-rewritten stylesheet/script/preload refs hit the storage path map, never the legacy basename fallback. ADDED requirement "Absolute source URLs stored for stylesheet, script, and document uploads" (fix G) — uploaded css/js/documents carry their absolute source URL as `original_url` and the session filename map covers all four asset categories.
- `archived-file-proxy`: MODIFIED requirement "Route Allow-List and Traversal Rejection" — the composed-path pattern admits bare route families (`(\/|$)`), unblocking `POST/GET /api/v1/share` through the BFF.
- `server-api`: MODIFIED requirements "Resource File Upload" (counter semantics reconciled with the deadlock fix: no per-upload session-row updates; live aggregate is authoritative) and "Session Finalization" (finalize-time column reconciliation + loud discovery/received deficit warning, never a refusal).
- `upload-timeouts`: MODIFIED requirement "Resource upload request timeout" — timeout aborts (`DOMException` `TimeoutError`) are explicitly classified retryable, distinct from terminal user-cancellation `AbortError`.
- `download-ux-feedback`: ADDED requirements — terminal upload failures are logged (once per class, no spam) and completed downloads report failed-upload counts in the `status.complete` payload + panel state.
- `server-session-resume`: MODIFIED requirement "Server session resume from checkpoint" — the task manifest is complete (size added) and keyed per download in `chrome.storage.session` (blobs never persisted), so post-SW-death resume drains into a fresh queue.

## Impact

- **Code (pagepocket frontend)**: `pagepocket/frontend/src/app/api/pp/[...path]/route.ts` (ACAO on file responses, allow-list regex), `pagepocket/frontend/src/app/api/sc/[token]/[...path]/route.ts` (ACAO), `src/lib/serving-headers.ts` (shared CORS header helper), `route.test.ts` files, `src/lib/client-api.ts` (no code change expected — unblocked by B), `src/sidepanel/server-mode-state.ts` + completion components (failedCount display).
- **Code (monolith)**: `server/app/api/routes/sessions.py` (finalize reconciliation + integrity warning), `server/tests/` (regression tests).
- **Code (extension)**: `src/background/upload-queue.ts` (TimeoutError classification, terminal-failure logging), `src/background/download-core.ts` (failedCount in status.complete, per-download checkpoint manifest), `src/background/download-checkpoint.ts` (per-download keying, size field), fix G: `src/background/fileHandlers/css.ts|js.ts|documents.ts` + `src/background/download-processors.ts` (absolute originalUrl + filename maps) and `src/background/linked-page-scraper.ts` (merged per-page/delta maps), `tests/unit/*` (four new test groups + fix G regression suite).
- **Deploy coupling**: none server-side for A–D — the gateway is untouched, no wire contract changes; the frontend deploy (`deploy-frontend`, path filter `pagepocket/frontend/**`) is independent; the monolith is manual-rebuild only (`server/**` is in no deploy filter — `scripts/prod/README.md` §13 gotcha); the extension ships independently (user rebuild + reload). Fix E ADDS a coupled server-side change: the gateway must accept the token on the archive file route and share the `ASSET_TOKEN_SECRET` — frontend + gateway (+ compose env, which doubles as the backend deploy marker) must ship together, and the frontend must not ship the feature before the gateway understands `at/{token}/` URLs.
- **Out of scope**: gateway CORS changes (by design — allow-list can never contain `null`); any relaxation of the iframe sandbox (`allow-same-origin` stays dropped); persisting upload blobs to storage; retroactive backfill of historical stale `resources_received` rows.
