## 1. Pagepocket frontend — A: opaque-origin viewer CORS (archived-html-serving)

- [x] 1.1 Add a shared CORS-echo helper in `pagepocket/frontend/src/lib/serving-headers.ts` (the module that owns the sandbox header set): given the request `Origin` header, produce `Access-Control-Allow-Origin: <origin>` (echoed verbatim, including the literal `null`), `Access-Control-Allow-Credentials: true`, `Vary: Origin`; return no ACAO headers when `Origin` is absent
- [x] 1.2 Wire the helper into `pagepocket/frontend/src/app/api/pp/[...path]/route.ts` `proxyResponse` for FILE responses only (when `filePath != null`, i.e. upstream archive page-file routes containing `/f/`) — non-file API routes and responses must gain no ACAO
- [x] 1.3 Wire the helper into `pagepocket/frontend/src/app/api/sc/[token]/[...path]/route.ts` success path (all served files) with the same file-only, origin-echo semantics
- [x] 1.4 Add `pagepocket/frontend/src/app/api/pp/[...path]/route.test.ts` cases: file response with `Origin: null` → `Access-Control-Allow-Origin: null` + `Access-Control-Allow-Credentials: true` + `Vary: Origin`; non-file (JSON API) response with `Origin` → NO ACAO; file response without `Origin` → NO ACAO
- [x] 1.5 Add the same three assertions to `pagepocket/frontend/src/app/api/sc/[token]/[...path]/route.test.ts` (note: this route has no non-file proxying — cover the no-Origin and Origin-echo cases there)
- [x] 1.6 Grep gate: no ACAO emission outside the two file proxies (`pagepocket/frontend/src/**`) and zero changes to `pagepocket/services/api-gateway/**` (CORS stays gateway-untouched by design)
- [x] 1.7 Note the frontend AGENTS.md constraint in the PR body: this Next.js version has breaking changes — read `node_modules/next/dist/docs/` before touching route-handler signatures

## 2. Pagepocket frontend — B: share-proxy allow-list (archived-file-proxy)

- [x] 2.1 Change `ALLOWED_UPSTREAM` in `pagepocket/frontend/src/app/api/pp/[...path]/route.ts:21` to `/^\/api\/v1\/(archive|library|search|share|auth)(\/|$)/` (bare family roots admitted; traversal checks in `proxy-path.ts` untouched)
- [x] 2.2 Extend the allow-list tests in `pagepocket/frontend/src/app/api/pp/[...path]/route.test.ts` (existing suite near lines 185-230): `POST ["share"]` and `GET ["share"]` forward to `${API_BASE}/share` (family root); `["docs"]`/`["openapi.json"]`/encoded-dot cases still 400 without proxying
- [ ] 2.3 Verify the share dialog end-to-end locally: `createLink` (`src/lib/client-api.ts:196-201`) and `getLink` (`:210-218`) no longer surface 400 "Proxied route not allowed"; no `src/lib/client-api.ts` change expected

## 3. Monolith — C: resources_received integrity (server-api)

- [x] 3.1 Reconcile the column at finalize: in `server/app/api/routes/sessions.py` finalize route (≈642-716), beside the existing status-transition commit, set `session.resources_received` to the already-computed aggregate `resource_count` — one UPDATE per session lifetime, no per-upload writes (respects the documented deadlock fix at `:193-196`)
- [x] 3.2 Add the finalize-time integrity warning: when `session.resources_discovered` is not None and `resources_discovered > resource_count`, log a loud structured warning carrying `session_id`, `resources_discovered`, and `resources_received` — visibility only; do NOT refuse or alter any finalize status code
- [x] 3.3 Update the stale docstring/comment pair (`sessions.py:193-196`, `session_manager.py:228-243`) to describe the finalize-time reconciliation + live status aggregates as the two sources of truth
- [x] 3.4 Add `server/tests/` regressions: (a) uploads leave `sessions.resources_received` untouched mid-flight but finalize sets it to the exact row count; (b) deduplicated re-uploads don't inflate the reconciled count; (c) `discovered > received` emits the structured warning AND still finalizes 202; (d) `discovered <= received` logs nothing
- [x] 3.5 Confirm no server-side reader of the stored column exists beyond `_session_to_response` (create/list) — the extension resume path reads the live `/status` aggregate (`download-core.ts:1262`); record the audit in the PR body

## 4. Extension — D: upload robustness (src/)

- [x] 4.1 Classify timeout aborts as retryable: extend `isRetryableError` (`src/background/upload-queue.ts:695-716`) to treat `DOMException` with name `TimeoutError` as retryable; `isAbortError` (:637-646) keeps matching only `AbortError` so user cancellation stays terminal
- [x] 4.2 Log every terminal failure class exactly once: structured `console.warn`/`error` at terminality in `handleTaskError` for `AuthenticationError` (:468-475) and retries-exhausted (incl. timeout exhaustion), one log for the 413 session-full fail-all drain (:478-501, not per drained task), and one on `cancel()` (:210-242) summarizing cancelled active+pending counts
- [x] 4.3 Surface failedCount: include `failedCount` in the `status.complete` payload built in `src/background/download-core.ts` (both the normal and resume completion paths) and consume it in `src/sidepanel/server-mode-state.ts` completion state so a "completed with N failed uploads" renders visibly partial in the panel
- [x] 4.4 Persist the resume task manifest per download: extend `src/background/download-checkpoint.ts` — manifest entries gain `size` (from the upload task), storage is keyed per download (e.g. by server session id, replacing the single global `downloadCheckpoint` key), blobs are never persisted; startup detection (`cleanupHandlers.ts`) enumerates all keys; update `updateCheckpointResourceUrls`/`getResourceUrls` flow in `download-core.ts:858-869`
- [x] 4.5 Add vitest suites in `tests/unit/`: (a) `upload-queue.test.ts` — `TimeoutError` aborts are retried and eventually succeed, `AbortError` remains terminal, each terminal class logs exactly once (413 drain = one log), `cancel()` logs a summary; (b) new resume-produces-uploads test — with a checkpoint manifest and mocked `fetch`, `resumeServerDownload` re-fetches entries into a fresh `UploadQueue`, produces real upload calls, and finalizes (no existing test covers this); (c) checkpoint keying — two concurrent downloads keep independent manifests, `size` persisted, blobs absent from storage writes
- [x] 4.6 Verify `status.complete` payload consumers (`src/sidepanel.tsx:272,414`, `DownloadComplete` component) tolerate the additive `failedCount` field and that a clean download renders unchanged

## 5. Docs & spec hygiene

- [x] 5.1 Update `scripts/prod/README.md` verification notes: the page-5ecce3ab render checklist, share-link curl, the `resources_received` probe SQL, and the §13 monolith-rebuild reminder (fetch + `git reset --hard origin/pagepocket` BEFORE rebuild) — reference from the deploy-gated tasks
- [x] 5.2 Run `openspec validate fix-archived-page-pipeline` until valid; confirm `openspec list` shows exactly two active changes and no delta requirement names collide with `close-cloud-lifecycle-gaps`

## 6. DEPLOY-GATED (user-ordered) — deploy & prod verification

- [x] 6.1 (DEPLOY-GATED) Frontend deploy: push to `pagepocket` fires the CI-gated `deploy-frontend` job on `pagepocket/frontend/**` paths (`.github/workflows/deploy.yml` filter); gateway is untouched by this change — NO backend deploy fires and none is needed (no wire contract changes; the runbook's gateway↔service atomicity rule does not couple here)
- [ ] 6.2 (DEPLOY-GATED) Verify fix A in prod: re-open page `5ecce3ab-7b6c-4a8c-a467-6a06ff791f37` in the logged-in viewer — fonts, images, and styles render; no CORS console errors; repeat for a shared page via `/s/{token}`
- [ ] 6.3 (DEPLOY-GATED) Verify fix B in prod: mint a share link via the UI dialog → open `/s/{token}` → renders; `curl -X POST https://app.pagepocket.app/api/pp/share` (authenticated) no longer returns 400 "Proxied route not allowed"
- [x] 6.4 (DEPLOY-GATED) Monolith deploy (manual — `server/**` is in NO deploy path filter, scripts/prod/README.md §13 gotcha): on the host fetch + `git reset --hard origin/pagepocket` FIRST, then rebuild `server-app-1` (§3 step 3b); skip if 6.1 already shipped the same SHA in a backend-coupled run — it cannot, by filter design
- [x] 6.5 (DEPLOY-GATED) Verify fix C in prod: extension upload probe (curl multipart resource upload to a scratch session) → confirm the `resources` row appears; after finalize, `SELECT resources_received FROM sessions WHERE id=…` equals the row count; upload one fewer resource than `resources_discovered` → structured deficit warning in server logs, finalize still 202
- [ ] 6.6 (DEPLOY-GATED) Extension ship: user rebuild + reload (`pnpm build`, reload unpacked or store update); verify kill-the-SW mid-download (chrome://serviceworker-internals) → panel offers Resume → resume completes WITH uploads (network tab shows re-fetched assets being POSTed); force a hung upload (devtools throttling/offline) → retry visible in logs, terminal outcome logged once, and the completion state shows the failed count
