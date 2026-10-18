## Context

A production diagnosis on 2026-10-16/18 traced two user-visible breakages and two integrity gaps. Page `5ecce3ab-7b6c-4a8c-a467-6a06ff791f37` (user `6b8136ae-a772-4e16-93ab-3518d609c754`) is fully archived — all 103 assets verified in R2 under `{user}/{page}/assets/…` via `list_objects_v2` — yet the viewer at `app.pagepocket.app` renders text-only. Root cause chain: the viewer iframes are origin-isolated by design (`IFRAME_SANDBOX = "allow-popups allow-forms"` in `page-viewer-shell.tsx:33` / `public-viewer-shell.tsx:14`; `allow-same-origin` was dropped in `4895059`, previously present in `f9b7933`), so the archived document runs on an opaque origin whose string value is `null`. Every subresource request it makes is CORS-mode — webfonts always request in CORS mode, and preserved `crossorigin` attributes from source pages put css/js/img in CORS mode too. No component answers with `Access-Control-Allow-Origin`: the frontend proxies emit only the sandbox header set (`route.ts` `proxyResponse` → `serving-headers.ts:68-79`), and the gateway's `CORSMiddleware` allow-list (`main.py:66-71`, `config.py` `allowed_origins()`) can never contain the literal `null` — `*` is actively dropped with a warning by design. The browser blocks every css/js/img/font load; text survives because plain HTML/`no-cors` image loads differ per mode — the net effect is the observed text-only render.

The same diagnosis found share-link creation dead: both the UI dialog (`client-api.ts` `createLink` → `POST /api/pp/share`) and a raw `curl POST /api/pp/share` return `{"error":"Proxied route not allowed"}` — the BFF `ALLOWED_UPSTREAM` regex requires a `/` after the route family, while the gateway exposes `@router.post("")` / `@router.get("")` at the `/share` root (`services/api-gateway/routers/share.py:39,76`).

On the monolith, the resource upload route works end-to-end (multipart POST → 200 `{resource_id}`, row in `resources`, file on disk, through Cloudflare + nginx — `resources.py:121-419`), but the `sessions.resources_received` COLUMN stayed 0 forever (live probe 2026-10-18: 103 rows, column 0). The status ENDPOINT computes the count live (`sessions.py:395,424`), so APIs are correct — including the extension resume path, which reads `status.resources_received` via `getSessionStatus` (`download-core.ts:1262`). The stale column misleads ops probes and surfaces in create/list responses only (`_session_to_response`, `sessions.py:194-205`).

### Evidence table (prod probes, 2026-10-16/18)

| #   | Probe                                                                                              | Finding                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | `list_objects_v2` on page `5ecce3ab…`                                                              | All 103 assets present under `{user}/{page}/assets/…` — storage is NOT the problem                                                                                    |
| E2  | Viewer DOM + network panel, `app.pagepocket.app`                                                   | Text-only render; css/js/img/font requests blocked, no ACAO on any response                                                                                           |
| E3  | `IFRAME_SANDBOX` (`page-viewer-shell.tsx:33`, `public-viewer-shell.tsx:14`)                        | `"allow-popups allow-forms"` — opaque origin `null` (since `4895059`; `allow-same-origin` in `f9b7933`)                                                               |
| E4  | `pagepocket/frontend/src/app/api/pp/[...path]/route.ts:63-84` + `src/lib/serving-headers.ts:68-79` | File responses carry sandbox headers only; no ACAO ever emitted                                                                                                       |
| E5  | `services/api-gateway/main.py:66-71` + `config.py:33,89-109`                                       | CORS allow-list pinned; `*` dropped by design — `null` unreachable at the gateway                                                                                     |
| E6  | UI share dialog + `curl POST /api/pp/share`                                                        | Both fail `{"error":"Proxied route not allowed"}` (400 at `route.ts:264-269`); gateway routes exist (`routers/share.py:39,76`)                                        |
| E7  | Monolith live probe 2026-10-18                                                                     | 103 rows in `resources`; `sessions.resources_received` = 0; upload route returns 200s end-to-end                                                                      |
| E8  | `sessions.py:193-196` comment + git history                                                        | The column is stale BY DOCUMENTED DECISION ("no longer updated per-upload — deadlock fix"); status endpoint computes live (`:424`)                                    |
| E9  | Repo-wide grep                                                                                     | Zero COOP/COEP anywhere in first-party source — no cross-origin-isolation constraints constrain the CORS decision                                                     |
| E10 | `upload-queue.ts:637-646,695-716`                                                                  | `isAbortError` matches only `AbortError`; `TimeoutError` from `AbortSignal.timeout()` falls through to non-retryable → hung upload = single-attempt permanent failure |

## Goals / Non-Goals

**Goals:**

- Archived pages render fully (fonts, images, styles, scripts-as-stored) in the sandboxed logged-in and public viewers.
- Share-link creation works through the BFF (UI dialog + raw API).
- The monolith `resources_received` column becomes truthful where it is consumed, with a loud finalize-time deficit signal.
- Extension upload failures can never look like success: timeouts retry, terminal failures log, failed counts surface, SW death is recoverable.

**Non-Goals:**

- No gateway CORS changes — its allow-list model (never `*`, never `null`) is correct for interactive clients; the fix belongs at the file-serving edge.
- No sandbox relaxation — `allow-same-origin` stays dropped (XSS containment, `archived-html-serving`).
- No per-upload session-row counter updates on the monolith (see D3).
- No blob persistence in the extension (memory-safety, `memory-safety` capability).
- No backfill of historical stale `resources_received` rows (retention is short; finalize-time reconciliation covers all future sessions).

## Decisions

### D1. CORS is answered by the file-serving proxies, not the gateway

The opaque `null` origin is a property of the _viewer iframe_, and the entities that serve that iframe its document and assets are the two Next.js proxies. Both are already auth-gated (`pp_access` cookie for `/api/pp`, share token for `/api/sc`) and exist solely to deliver one page's immutable archived content to its viewer. On FILE responses (the `/api/pp` archive page-file routes — upstream paths containing `/f/` — and all `/api/sc/{token}/…path` responses), the proxy SHALL echo the request `Origin` header — including the literal string `null` — into `Access-Control-Allow-Origin`, add `Access-Control-Allow-Credentials: true` (the `/api/pp` route authenticates via cookies) and `Vary: Origin` (so shared caches never serve one origin's CORS answer to another). Non-file API routes gain nothing; requests without `Origin` gain nothing.

_Security rationale:_ echoing `Origin` on a credentialed response is normally risky because it lets any origin read authenticated data. Here the exposure is bounded by construction: the routes serve only immutable archived bytes of the page the caller is already entitled to view, the content is sanitized at ingest (`archived-html-serving` "Sanitization at ingest"), the sandbox CSP ships on every such response, no COOP/COEP is in play (E9), and the reflected origin never expands what the caller can read — a foreign origin gains nothing it could not fetch by opening the same share URL. The gateway is the wrong layer: its allow-list model intentionally never matches `null`, and subresource requests come from the iframe, not from pagepocket.app.

_Implementation shape:_ a shared helper in `serving-headers.ts` (the module that already owns the sandbox header set) so both proxies emit identical headers; `/api/pp` applies it inside `proxyResponse` when `filePath != null`, `/api/sc` in its success path. The gateway's responses pass through untouched — the proxy overlays on its own response, exactly like the existing sandbox-header mirroring.

### D2. The share allow-list admits bare family roots

`ALLOWED_UPSTREAM` becomes `/^\/api\/v1\/(archive|library|search|share|auth)(\/|$)/`. This admits `/api/v1/share` (family root) while everything deeper still requires membership in an allowed family. Traversal safety is orthogonal and untouched: `isSafeSegment` (`proxy-path.ts:13-29`) still rejects dot-segments/encoded separators per segment before the composed path is tested. The gateway's `POST ""`/`GET ""` share routes (`routers/share.py:39,76`) are then reachable exactly as the UI's `createLink`/`getLink` intend. `revokeLink` (`/share/{token}`, DELETE) already passes today (has the `/`).

### D3. `resources_received` is reconciled at finalize — not per upload

The column is stale by documented decision: per-upload session-row counter updates caused MySQL deadlocks and were deliberately removed ("no longer updated per-upload (deadlock fix)", `sessions.py:193-196`; consumers directed to the live `/status` aggregates). Re-introducing a per-insert UPDATE would contradict that decision and re-serialize parallel uploads of one session on the sessions-row lock. A generated column is technically infeasible: MySQL generated columns cannot reference other tables or subqueries.

The scoped fix: the finalize route already computes the authoritative `resource_count` via aggregate query for its empty-session check; finalize additionally writes `sessions.resources_received = <count>` in the same status-transition commit (one UPDATE per session lifetime, zero per-upload contention) and, when the client-reported `resources_discovered` exceeds the stored count, emits a loud structured warning carrying both counts + session id. The warning is visibility, NOT a refusal — finalize semantics (202 on success, 409/422 paths) are unchanged, and partial downloads remain valid (`server-api` "Upload exceeds total session size limit" scenario). Column-maintenance vs generated-column was decided per repo conventions: the repo's own documented convention is "no per-upload session-row writes" — hence finalize-time reconciliation. Ops truth is restored exactly where it was observed broken (terminal sessions; the E7 probe session is finalized), active-session list/create responses stay documented-stale, and the `/status` API remains the live authority for the extension.

### D4. Extension upload failures: retry, log, surface, recover

1. **Timeout classification**: `AbortSignal.timeout()` rejects with `DOMException` name `TimeoutError`, which `isAbortError` (matches only `AbortError`) and `isRetryableError` both miss → permanent single-attempt failure. `isRetryableError` gains the `TimeoutError` case (retryable); user cancellation stays `AbortError`-terminal so `cancel()` semantics are untouched. This aligns the code with the already-live spec text ("the error is classified as retryable by the upload queue", `upload-timeouts`).
2. **Terminal-failure logging**: four silent terminal classes each emit exactly ONE structured `console.warn`/`console.error` at the moment they become terminal — `AuthenticationError` (after ServerClient's own re-registration attempts), abort/cancel (`cancel()` and per-task abort), 413 session-full (the fail-all drain logs once for the session, not per drained task), and retries-exhausted (including timeout exhaustion). No per-attempt spam; retries already log at the retry decision points.
3. **failedCount surfaced**: `getProgress()` already tracks `failedCount`; it is added to the `status.complete` payload (alongside `downloadUrl`/`isSingleFile`) and to `server-mode-state.ts` completion state, so a "completed" download with N failed uploads renders visibly partial in the panel instead of a clean success hero.
4. **SW-death recoverability**: the queue is in-memory and the adapter is constructed per download; after a service-worker death only the `chrome.storage.session` checkpoint survives. The checkpoint manifest (`download-checkpoint.ts`) already carries `{url, path, contentType}` and is written before the upload drain; the manifest is completed with `size` and keyed PER DOWNLOAD (today: single global key `downloadCheckpoint`, so concurrent downloads clobber each other) with blobs explicitly never persisted. The existing `resumeServerDownload` path re-fetches URLs into a fresh `UploadQueue` and drains — the gap is that NO test proves resume produces uploads; a regression test is part of this change.

### Failure-isolation rules

- **C logs but never blocks**: the finalize deficit warning is emitted and finalize proceeds; no new refusal path.
- **D failures always visible**: every terminal failure class logs; the completion payload carries `failedCount`; a resume that cannot re-fetch a resource skips and logs (existing semantics) but the final `failedCount` reflects it.
- **A/B fail closed**: absent `Origin` → no ACAO; disallowed route → 400 exactly as today.

## Risks / Trade-offs

- **[D1 reflected-origin credentials]** Echoing `Origin` with credentials is only acceptable because the resource set is immutable, entitlement-checked, and sandboxed. → Mitigation: ACAO is emitted ONLY on file responses of the two proxies (never on JSON/API routes), with `Vary: Origin`; frontend route tests pin the no-Origin and non-file cases.
- **[D1 shared caches]** `/api/sc` sets `Cache-Control: public, max-age=3600` for anonymous share assets; a cache ignoring `Vary: Origin` could serve a CORS answer cross-origin. → Mitigation: `Vary: Origin` is the standard contract (Cloudflare honors it); the assets themselves are origin-agnostic immutable bytes, so even a miss is a correctness-of-delivery issue, not a data-leak issue.
- **[D3 finalize write]** The reconciliation UPDATE rides the finalize transaction — a lock held marginally longer on one row, once per session. → Mitigation: single row, single statement, same transaction as the existing transition; covered by the existing finalize concurrency test.
- **[D4.1 timeouts retried]** A genuinely dead endpoint now consumes the retry budget (up to MAX_RETRIES with backoff) before failing visibly. → Mitigation: bounded retries already exist; terminal exhaustion is now loud (D4.2) and surfaced (D4.3).
- **[D4.4 per-download keys]** Startup recovery must handle multiple checkpoint keys. → Mitigation: key namespace is enumerated on startup detection; lifecycle tests cover clear-on-success/keep-on-failure per key.

## Migration Plan

1. Frontend A+B (one deployable unit: both are `pagepocket/frontend/**`) with route tests.
2. Monolith C with pytest regressions (finalize reconciliation + deficit warning).
3. Extension D1–D4 with vitest suites (classification, logging, failedCount payload, resume-produces-uploads).
4. Spec-delta validation + docs; deploy-gated verification sequence (tasks §6).

Rollback: each item reverts independently (frontend revert re-hides pages behind CORS — acceptable, no data effect; monolith revert restores the stale-but-harmless column; extension revert restores prior silence).

## Open Questions

- Should the `/api/sc` CORS echo also apply to the 404/error text responses (currently no ACAO)? Chosen: no — only successful file deliveries matter to the iframe; error paths are not consumed cross-origin.
- Should historical stale `resources_received` rows be backfilled at the next monolith deploy? Chosen: no — retention-expired rows disappear naturally; the deficit warning flags any live discrepancy.
