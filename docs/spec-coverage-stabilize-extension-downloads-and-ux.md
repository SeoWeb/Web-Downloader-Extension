# Spec coverage — `stabilize-extension-downloads-and-ux`

Walk of every requirement/scenario in `openspec/changes/stabilize-extension-downloads-and-ux/specs/**` against the automated suite (`tests/unit/`, vitest) as of Oct 2026 (post wave 2 + integration + browser e2e).

Legend:
- **automated** — covered by a unit test (`test-file : test name`)
- **e2e** — covered by a browser test: `tests/e2e/download-pipeline.test.cjs` scenario **R1-R9** (recording mock server + fixture site; R9 needs `E2E_CONCURRENT=1`) or `tests/e2e/ui-smoke.test.cjs` scenario **S1-S7** (load/render/i18n slice against `dist/`)
- **manual** — needs human/browser verification (listed in `docs/manual-smoke-test.md`)
- **gap** — no automated test and no documented manual step yet

Summary: **73 scenarios — 47 automated (several with additional e2e coverage), 19 manual, 6 gaps.**

## asset-rewrite-correctness

| Requirement | Scenario | Coverage |
|---|---|---|
| Relative URLs resolved against the document URL | Page-relative asset on a nested page downloads | automated — `file-handler-pipeline.test.ts : resolves relative image URLs against the document URL (nested page scenario)`; e2e — download-pipeline **R1** (nested fixture: `/dir/img/x.png` fetched, `images/dir/img/x.png` uploaded, no host-root-joined fetch from the session) |
| Relative URLs resolved against the document URL | Linked-page assets resolve against the linked page | automated — `file-handler-pipeline.test.ts : resolves parent-relative references from linked pages against their own URL` |
| Relative URLs resolved against the document URL | Dedup and fetch agree on the resolved URL | automated — `asset-registry-equality.test.ts : registry dedup keys survive absolute-URL resolution like the scrapers filter` + `registry keys equal the paths handlers upload to (round-trip)`; e2e — R1/R2 (fetches and uploads round-trip through the recording server) |
| Charset-aware text decoding | Shift_JIS stylesheet is not corrupted | automated — `css-handler.test.ts : decodes Shift_JIS content via the Content-Type charset header`; e2e — **R3** (uploaded bytes decode as intact Japanese, no mojibake) |
| Charset-aware text decoding | Charset from @charset when header is absent | automated — `css-handler.test.ts : decodes iso-8859-1 via the @charset rule (spec scenario)` |
| Imported stylesheets and favicons are captured | Nested import downloads | automated — `css-handler.test.ts : downloads a nested import chain (url form + string form)`; e2e — **R4** (a.css → b.css → c.css fetched + uploaded) |
| Imported stylesheets and favicons are captured | Favicon downloads | automated — `resources-extraction.test.ts : extracts rel=icon, rel=shortcut icon and rel=apple-touch-icon hrefs` (discovery; download path is the shared image-handler pipeline covered by `file-handler-pipeline.test.ts`); e2e — **R5** (`/favicon.ico` fetched, `images/favicon.ico` uploaded) |
| Imported stylesheets and favicons are captured | Import cycles terminate | automated — `css-handler.test.ts : downloads each side of an import cycle exactly once` + `stops recursion at the depth cap of 3` |
| Collision-free archive paths | Two same-basename stylesheets coexist | automated — `css-handler.test.ts : stores same-basename stylesheets from different directories at distinct paths` + `build-archive-path.test.ts : produces distinct paths for same-basename files from different directories`; e2e — **R2** (`styles/a/main.css` "ALPHA" + `styles/b/main.css` "BETA") |
| Collision-free archive paths | Registry keys match uploaded paths | automated — `asset-registry-equality.test.ts : registry keys equal the paths handlers upload to (round-trip)`; e2e — R1/R2 (uploaded paths observed per session) |
| Non-downloadable URL schemes are filtered | Blob URL does not poison the queue | automated — `file-handler-pipeline.test.ts : skips blob: and data: image URLs without enqueueing them` + `resources-extraction.test.ts : does not return blob: image URLs`; e2e — **R6** (scraped DOM contains the blob: img; 0 fixture requests, 0 uploads) |
| Non-downloadable URL schemes are filtered | SVG fragment reference is not fetched as an image | automated — `css-handler.test.ts : never fetches CSS url(#fragment) references` + `resources-extraction.test.ts : never treats CSS url(#fragment) as a fetchable image`; e2e — **R6** (0 requests matched `gradient`) |
| Linked-page collection is bounded | PDF link is not uploaded as HTML | automated — `linked-page-collection.test.ts : does NOT upload a PDF link as HTML and counts it as skipped`; e2e — observational (download-pipeline run output prints `linked html chunks=0` for the fixture's `/doc.pdf` link) |
| Linked-page collection is bounded | Non-HTML response is skipped | automated — `linked-page-collection.test.ts : skips non-HTML responses (zip, images, json)` |

## concurrent-downloads

| Requirement | Scenario | Coverage |
|---|---|---|
| Download-scoped shared mutable state | Concurrent tabs do not corrupt each other's filename maps | automated — `download-core-teardown.test.ts : scopes teardown while another tab's download is still active` / `runs the full global teardown when this is the last download` / `scopes teardown after a memory-classified error with a peer active`, `download-state-concurrency.test.ts` (active-downloads gating), `request-queue.test.ts` (D7: per-download scoping of queue teardown); e2e — **R9** (`E2E_CONCURRENT=1`: two tabs → distinct sessions, both finalized, per-session uploads/filename maps) |
| Download-scoped shared mutable state | Assembly polling cancellation is scoped per download | automated — `server-download.test.ts : cancelling one poll leaves a concurrent poll running (task 4.2)` + `does not expose a shared polling controller field (task 4.2)`; e2e — **R9** (both tabs poll to ready independently) |
| Download-scoped shared mutable state | No global state persists between downloads | automated (partial) — stale *memory* is covered (`memory-manager.test.ts : back-to-back downloads are not blocked by stale usage`), per-download teardown scoping by `download-core-teardown.test.ts`; e2e — **R9** (second concurrent download unaffected by the first's teardown). Filename-map/dedup-key freshness of a new `DownloadContext` has no direct unit test. |

## download-fetch-pipeline

| Requirement | Scenario | Coverage |
|---|---|---|
| Fetch timeout enforcement | Hung socket does not block the queue | automated — `request-queue.test.ts : aborts a hung fetch after requestTimeout and releases the queue slot`; e2e — **R7** (`/slow.png` stalls past the 30s requestTimeout, attempt aborted, run completes) |
| Fetch timeout enforcement | Timeout respects download cancellation | automated — `request-queue.test.ts : aborts immediately on download cancel, independent of the timeout` |
| Credentialed asset fetches | Asset behind a login session downloads | automated — `request-queue.test.ts : fetches with credentials include and retries once with omit on 4xx` (request-init assertion); e2e — **R7** (fixture requests carry the session cookie) |
| Credentialed asset fetches | Fallback to cookieless fetch on credentialed failure | automated — `request-queue.test.ts : fetches with credentials include and retries once with omit on 4xx` + `does not cookieless-retry non-4xx failures`; e2e — **R7** (deliberate 404 `/img404.png` re-requested after the credentialed 4xx without breaking the run) |
| Consumable dedup cache | Same URL referenced twice succeeds twice | automated — `request-queue.test.ts : serves two consumers of the same URL with independently readable bodies` |
| Consumable dedup cache | Large responses bypass the cache | automated — `request-queue.test.ts : bypasses the dedup cache and re-fetches bodies above 5MB` |
| Opaque response handling | CORS-blocked image is skipped, not crashed | automated — `file-handler-pipeline.test.ts : records a categorized cors failure for opaque responses and continues` + `image-handler-sniff.test.ts : records a categorized cors failure for opaque responses and never reads the body` |
| Opaque response handling | Opaque CSS response fails cleanly | automated — `css-handler.test.ts : records a categorized cors failure and uploads nothing` + `keeps processing the remaining stylesheets after an opaque failure` |
| Fair scheduling across rate-limited domains | Slow domain does not starve fast domains | automated — `request-queue.test.ts : starts ready requests from other domains while the head domain is rate-limited` |
| Fair scheduling across rate-limited domains | Idle loop waits instead of spinning | automated — `request-queue.test.ts : waits on the nearest limiter availability instead of busy-spinning` |

## download-lifecycle-reliability

| Requirement | Scenario | Coverage |
|---|---|---|
| Cleanup uses chrome.alarms | Cleanup runs after SW restart | automated — `cleanup-alarms.test.ts : registers both cleanup alarms with periods >= 1 minute` + `creates each alarm once per service-worker lifetime (no duplicate churn)` |
| Cleanup uses chrome.alarms | Cleanup never cancels active work | manual — periodic cleanup only frees stale session state; verify in-browser that a running download survives a 10-min idle period. |
| Single listener registration | Tab-close handler runs once per event | manual — once-only registration is unit-tested for the *alarms* listener (`cleanup-alarms.test.ts : registers listeners exactly once despite repeated initialization`); the tab-close listener itself is exercised only in-browser. |
| All panel notifications are enveloped and failure-tolerant | Interrupted-download push reaches an open panel | manual — `handleInterruptedDownload` → `sendMessageToPanel(DOWNLOAD_INTERRUPTED)` verified by reading code; needs a browser run (kill mid-download with panel open). |
| All panel notifications are enveloped and failure-tolerant | Closed panel does not produce unhandled rejections | manual — every send path is `.catch`-guarded in code; verify with panel closed mid-download (smoke matrix row "panel closed mid-download"). |
| HTML chunk uploads are retried | Transient network blip during scrolling | automated (mechanism) — `server-client.test.ts : retries on 5xx server errors (using statusCode)` + `retries on network-level TypeError (fetch failure)`; `uploadHtmlChunk` is wrapped in the same `withRetry` (`server-client.ts:349`). No chunk-specific retry test. |
| HTML chunk uploads are retried | Persistently failing chunk is visible | manual — error propagation to the panel (`useScrapingDownloader`) is UI behavior; smoke matrix. |
| Memory-pressure telemetry does not use external network | No background pings to third parties | automated — `throttling-manager.test.ts : never sends third-party congestion probes` |

## download-ux-feedback

| Requirement | Scenario | Coverage |
|---|---|---|
| Local fallback on server failure | Server down offers local fallback | automated — `server-download.test.ts : offers local fallback on AssemblyTimeoutError` + `offers local fallback on AssemblyFailedError`; state machine: `server-mode-state.test.ts : should transition to timeout on status.serverFallbackOffer with assembly_timeout` |
| Local fallback on server failure | No fallback available shows retry only | manual — `DownloadStatus` rendering of fallback vs retry-only actions. |
| Persistent failure summary on completion | Clean download shows a green report | **gap** — the report aggregator (`src/sidepanel/utils/downloadReport.ts`) has no unit test and the rendering is not covered. A jsdom test of the aggregator would close this cheaply. |
| Persistent failure summary on completion | Partial download is visible | **gap** — same as above. |
| Announcement dismissal persists | Maybe-later sticks | manual — persistence via `chrome.storage.local`; verify across panel reopen in-browser. |
| Explicit cancellation states | Stop during scraping with partial save | manual — "Saving what we captured…" + partial marker are UI states (smoke matrix). |
| Explicit cancellation states | Full cancel resets with feedback | manual — localized `status.cancelled` rendering (smoke matrix). |
| Accessibility conformance fixes | Duplicate IDs eliminated | manual — jsdom a11y assertions not present; verify with devtools audit. |
| Accessibility conformance fixes | Collapsed section is not tabbable | manual — verify `aria-expanded` + inert/hidden in-browser. |
| Accessibility conformance fixes | Language picker is keyboard operable | manual — Arrow/Escape handling in `LanguageSwitcher`. |
| Server failure is never a silent retry loop | (no scenarios in spec) | partial — state machine covered (`server-mode-state.test.ts : should transition to failed on status.serverError (server_unavailable)` / `assembly_failed` / `auth_failed`, `should transition to timeout on status.serverError with assembly_timeout reason`); final wording is manual. |

## extension-onboarding

| Requirement | Scenario | Coverage |
|---|---|---|
| First-run experience exists | Fresh install shows onboarding | manual — `chrome.runtime.onInstalled` ("install" → `welcome.html`) is browser-only behavior (smoke matrix). |
| First-run experience exists | Updated installs are not nagged | manual — install a previous version, update, verify welcome does not open. |
| One coherent UI surface | Build inputs match shipped UI | manual (build-verified) — `npm run build` output inspected 2026-10: `sidePanel.html`, `welcome.html`, `background.js` only; no `popup.html`; no references to deleted modules in `dist/*.js`. |
| Locale key coverage is enforced | No raw keys rendered to users | automated — `locale-coverage.test.ts : en.json contains every i18n key used in src/` |
| Locale key coverage is enforced | Coverage check fails on a missing key | automated — by construction, same check fails the suite on any missing `t()` key (asserted by the test's failure mode). |
| Downloads are not gated on auxiliary permissions | Panel is usable immediately after install | manual — `StoragePermissionBanner`/`usePermissions`/gate flow deleted (grep + build verified); verify in-browser on first open. |

## extension-security-hardening

| Requirement | Scenario | Coverage |
|---|---|---|
| No private keys in the repository | Fresh clone contains no signing material | manual (verified 2026-10) — `dist.pem`/`dist.crx` deleted, `*.pem`/`*.crx` in `.gitignore`; rotation runbook at `docs/key-rotation-runbook.md`. |
| Auth tokens live in session storage | Tokens do not survive a browser restart on disk | automated — `server-client.test.ts : persists the API key and instance ID to session storage, not local` + `scrubs legacy key material from chrome.storage.local`; `pagepocket-client.test.ts : login persists auth state to chrome.storage.session, not local` + `scrubs legacy auth state from chrome.storage.local on load` |
| Storage permission is required, not optional | Download works without any permission prompt beyond install | manual (verified 2026-10) — `public/manifest.json` declares `storage` in `permissions`; in-browser confirmation in smoke matrix. |
| Minimal web-accessible resources | Locales are not probe-able by websites | manual (verified 2026-10) — no `web_accessible_resources` key in `public/manifest.json`. |
| Manifest declares its runtime floor | Older Chrome does not install a broken extension | manual (verified 2026-10) — `minimum_chrome_version: "116"` in `public/manifest.json`. |
| Server URL transport security is enforced | Plain-HTTP server URL is refused | automated — `https-enforcement.test.ts : throws for URLs that only look like localhost` / `throws for an unparseable URL` / `exports a ConfigurationError` (non-loopback HTTP rejection) |
| Server URL transport security is enforced | Loopback HTTP remains allowed for development | automated — `https-enforcement.test.ts : allows an empty URL (unconfigured — callers guard that separately)` + `server-download.test.ts : allows loopback HTTP download URLs (local development)` |

## memory-safety

| Requirement | Scenario | Coverage |
|---|---|---|
| Accurate memory accounting | Usage returns to baseline after a download | automated — `memory-manager.test.ts : returns usage to baseline after sequential downloads (stall regression)` |
| Accurate memory accounting | Release of an unknown record is a no-op | automated — `memory-manager.test.ts : releasing an unknown record is a no-op that logs a warning` + `double release does not corrupt usage` |
| Accurate memory accounting | Force cleanup resets counters from live state | automated — `memory-manager.test.ts : forceCleanup recomputes usage from live allocations (stale high-water regression)` + `forceCleanup drops usage when nothing is in flight` |
| Ordered memory pressure levels | Low pressure does not trigger cleanup | automated — `cleanup-alarms.test.ts : does nothing at LOW pressure` + `memory-manager.test.ts : never fires pressure handlers while pressure is low` |
| Ordered memory pressure levels | Critical pressure triggers cleanup | automated — `cleanup-alarms.test.ts : frees memory at CRITICAL pressure` + `fires the CRITICAL handler on transition into CRITICAL` + `does not fire repeatedly while pressure stays CRITICAL (transitions only)`; numeric rank: `memory-manager.test.ts : compares levels by numeric rank (low < medium < high < critical)` |
| Recoverable memory gating | Queue resumes after pressure clears | automated — `memory-manager.test.ts : recovers the queue resume path after critical pressure clears` |
| Recoverable memory gating | Back-to-back downloads are not blocked by stale usage | automated — `memory-manager.test.ts : back-to-back downloads are not blocked by stale usage` |

## page-compat-handling

| Requirement | Scenario | Coverage |
|---|---|---|
| Script injection failures surface as errors | Restricted page fails fast | automated — `execute-script.test.ts : rejects when chrome.scripting.executeScript rejects (restricted page)` + `propagates rejections for crashed tabs` |
| Script injection failures surface as errors | Injection returns nothing usable | automated — `execute-script.test.ts : resolves {success:false} when all injection results are falsy (empty array)` (+ every-frame-falsy and missing-results variants) |
| Unsupported pages are detected before start | chrome:// page shows unsupported state | **gap** — `src/sidepanel/hooks/useActiveTabInfo.ts` URL validation has no unit test; a jsdom/react-hooks test would close it. |
| Unsupported pages are detected before start | Supported page shows the normal form | **gap** — same hook, untested. |
| Unsupported pages are detected before start | Tab switches update the state | **gap** — `tabs.onActivated` re-evaluation untested. |
| HTTP status is checked before capture is reported | (no scenarios in spec) | partial — same validation path as above; currently manual-only. |

## scrape-checkpoint

| Requirement | Scenario | Coverage |
|---|---|---|
| Checkpoint survives failed resume attempts | Transient failure keeps recovery possible | automated — `resume-checkpoint-lifecycle.test.ts : keeps the checkpoint on transient failure (server unreachable)` + `keeps the checkpoint when the failure is a network TypeError` |
| Checkpoint survives failed resume attempts | Definitive failure clears the checkpoint | automated — `resume-checkpoint-lifecycle.test.ts : clears the checkpoint on definitive failure (expired session)` + `treats expired/failed sessions as definitive` / `auth failures as definitive` |
| Checkpoint survives failed resume attempts | Successful resume clears the checkpoint | automated — `resume-checkpoint-lifecycle.test.ts : clears the checkpoint on successful resume` |

## Gap recap (genuine, actionable)

1. ~~**concurrent-downloads**~~ — **closed**: per-download teardown scoping is unit-covered (`download-core-teardown.test.ts`, `download-state-concurrency.test.ts`, `request-queue.test.ts` D7) and two concurrent tabs are e2e-covered (download-pipeline **R9** with `E2E_CONCURRENT=1`).
2. **download-ux-feedback**: `downloadReport` aggregation has no unit test (both completion-report scenarios).
3. **page-compat-handling**: `useActiveTabInfo` pre-validation (3 scenarios incl. `tabs.onActivated`) untested.

All other non-automated scenarios are inherently browser/UI behaviors and are routed to `docs/manual-smoke-test.md`.
