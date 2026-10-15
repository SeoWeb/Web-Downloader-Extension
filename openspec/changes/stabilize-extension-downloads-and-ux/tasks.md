## 1. P0 — Ship blockers

- [x] 1.1 Add unit tests for `MemoryManager` accounting (allocate/release round-trip, `forceCleanup` reset) that reproduce the stall: `queueResource`/`processQueue` mismatch and non-resetting `currentUsage` (`src/utils/MemoryManager.ts`)
- [x] 1.2 Fix memory accounting: bind `trackResourceAllocation`/`releaseResource` to the actual `RequestQueue` item lifecycle (allocate on response, release in the request's `finally`); make `forceCleanup` recompute usage from live allocations
- [x] 1.3 Add numeric rank to `MemoryPressureLevel` (`memoryLimits.ts`) and replace all lexicographic `>=` comparisons in `MemoryManager.ts` with rank comparisons; add tests (low never triggers, critical always triggers)
- [x] 1.4 Add `.catch`-style rejection to the `executeScript` wrapper (`src/common/chrome.ts`) and resolve `{success:false}` when all injection results are falsy; add tests for reject-path and all-falsy path
- [x] 1.5 Thread the document URL through `processImages`/`processAssets`/`processDocuments` into css/js/images/documents handlers and replace `origin + "/"` bases with the document URL (`src/background/fileHandlers/*`)
- [x] 1.6 Align the linked-page dedup filter (`linked-page-scraper.ts:809-825`) with the same document-URL resolution and add a regression test (nested page relative asset resolves to `/dir/...`)

## 2. Fetch pipeline hardening

- [x] 2.1 Change `RequestResult` to store a snapshot (`{ok, status, headers, bytes|text, contentType}`) and hand each consumer an independently readable result; skip caching bodies > 5 MB (`src/utils/RequestQueue.ts`, `src/types/queue.ts`); add a two-consumer test
- [x] 2.2 Enforce `requestTimeout` via a composite abort signal (external abort + timeout); classify aborts as `timeout`; add a fake-timer test proving a hung request releases its slot
- [x] 2.3 Switch primary asset fetches to `credentials: "include"` with one cookieless retry on 4xx; add request-init assertions in tests
- [x] 2.4 Flag opaque responses in `executeRequest`; skip with categorized `cors` failure in `images.ts` and `js.ts`; treat opaque as failure in `css.ts`; add tests
- [x] 2.5 Fix head-of-line blocking: scan past domain-limited heads and wait on nearest limiter availability instead of `break` + 10 ms spin; add a multi-domain scheduling test
- [x] 2.6 Fix `DomainLimiter` recovery to the configured default, thread `retryAfter` into `adjustRateLimit` from `RequestQueue`, and parse `Crawl-delay` only from the `*` robots group; add tests
- [x] 2.7 Remove the third-party congestion probe from `ThrottlingManager` (google.com ping); derive congestion from request outcomes; update its tests

## 3. Asset correctness

- [x] 3.1 Create `buildArchivePath(url, category)` preserving sanitized pathname segments with query-hash filenames; use it in all handlers, the asset registry, and the filename map (`src/background/fileHandlers/*`, `urlUtils.ts`)
- [x] 3.2 Add tests: two same-basename files from different directories produce distinct paths; registry keys equal uploaded paths; `server-storage-adapter` dedup no longer drops valid files
- [x] 3.3 Decode CSS/text with `Content-Type` charset, then `@charset`, then UTF-8 (`css.ts`); add a Shift_JIS decoding test
- [x] 3.4 Extract `@import` rules (url + string forms, depth cap 3, dedup) in `resources.ts`/`css.ts`; add cycle and nesting tests
- [x] 3.5 Add favicon extraction (`link rel=icon|shortcut icon|apple-touch-icon`) to the image resource list; add a test
- [x] 3.6 Filter `blob:`, `data:`, `chrome-extension:`, and fragment-only URLs from all resource lists before enqueueing; add tests (including `url(#svg)` not fetched)
- [x] 3.7 Bound non-full linked-page mode: verify content type before uploading `linked` HTML, skip non-HTML `href` targets, enforce size/timeout limits (`download-core.ts:489-507`); add tests for PDF-link and non-HTML skip

## 4. Concurrency & lifecycle

- [x] 4.1 Introduce a `DownloadContext` (filename map, dedup keys, abort controller, upload queue handle) created per `downloadResources` call and threaded through processors, handlers, and the scraper; delete the module-global filename map (`linked-page-scraper.ts:24-32`, `download-core.ts:445`)
- [x] 4.2 Change `ServerDownloadHandler.pollAssemblyStatus` to accept a caller-supplied `AbortSignal` per session; remove the singleton `pollingAbortController` field; add a two-concurrent-download cancellation test
- [x] 4.3 Move periodic cleanup from `setInterval` to `chrome.alarms` (register `onAlarm`, re-register on SW start) and remove the duplicate `setTimeout` registration path (`cleanupHandlers.ts`, `background.js`)
- [x] 4.4 Route all background→panel messages through the enveloped `sendMessageToPanel` helper (fix `background.js:28-37` raw push) and `.catch` every `sendMessage` promise (progress callbacks in `message.ts`, `download-listener.ts`)
- [x] 4.5 Wrap `serverClient.uploadHtmlChunk` in `withRetry` and surface exhausted chunk failures to the panel instead of skipping (`server-client.ts:264-295`, `useScrapingDownloader.ts:170-173`)
- [x] 4.6 Reorder resume: read checkpoint → run `resumeServerDownload` → clear only on success or definitive (expired/invalid) failure (`message.ts:220-222`, `download-core.ts`); add tests for transient-failure-keeps-checkpoint and expired-clears
- [x] 4.7 Fix `LinkedPageScraper` `maxPages` clamping and `restoreOriginalPage` to not clobber user navigation away from the original tab
- [x] 4.8 Wire the install listener: register `chrome.runtime.onInstalled` in `background.js` so that on `"install"` (not `"update"`) it opens the built welcome page (`welcome.html`)

## 5. UX feedback

- [x] 5.1 Pre-validate the active tab in `useActiveTabInfo` (https? only; exclude chrome://, edge://, chrome-extension://, Web Store, file:// without access) and render a localized unsupported-page state with the form disabled; react to `tabs.onActivated`
- [x] 5.2 Wire the local-fallback action in `DownloadStatus` to real fallback behavior using `status.downloadLocally`/`status.localFallbackWarning`; show Retry-only when no fallback exists
- [x] 5.3 Aggregate per-category summary messages into panel state and render a persistent "Download report" block (succeeded/failed/skipped per category, partial marker) in `DownloadComplete`
- [x] 5.4 Persist PagePocket announcement dismissal on "Maybe Later"/close (`PagePocketAnnouncement.tsx:25-33`)
- [x] 5.5 Add explicit cancellation states: "Saving what we captured…" for partial save, localized `status.cancelled` for full cancel
- [x] 5.6 A11y fixes: unique `singleFile` id, `aria-expanded` + inert/hidden collapsed config (`Filter.tsx:210-230`), Arrow/Escape listbox keyboard support in `LanguageSwitcher`, localize hardcoded English in `StoragePermissionBanner`, `PagePocketAnnouncement`, `ErrorBoundary`, `ErrorFallback`
- [x] 5.7 Build the first-run welcome page: replace the `<h1>Welcome</h1>` placeholder in `src/components/welcome/index.tsx` with real onboarding content (what the extension does, 3-step flow, open-the-panel CTA), add `welcome.html` to vite build inputs, and ensure it opens on install only (wired with 4.8, not on update)

## 6. i18n pipeline

- [x] 6.1 Add `status.finalizingPartial` and the 26 missing cloud/PagePocket keys to `src/i18n/locales/en.json`; verify every `t()` key in `src/` exists in `en.json`
- [x] 6.2 Write a sync script that copies missing `en.json` keys (English fallback text) into all other locale files and run it
- [x] 6.3 Add a vitest locale-coverage check that fails when a `t()` key is missing from `en.json` or a locale is missing an `en.json` key; wire into `npm test`
- [ ] 6.4 Trim `public/_locales/*` to manifest-required keys once the popup is removed (name/description/title)

## 7. Security & manifest

- [x] 7.1 Remove `dist.pem` and `dist.crx` from the repo, add `*.pem`/`*.crx` to `.gitignore`, and write the key-rotation + history-purge runbook (`docs/`); execute forward-fix
- [x] 7.2 Move PagePocket auth state and server API key persistence from `chrome.storage.local` to `chrome.storage.session` (`pagepocket-client.ts:607-655`, `server-client.ts:1014-1050`); keep automatic re-registration working; update tests
- [x] 7.3 Manifest: move `storage` to required `permissions`, add `minimum_chrome_version: "116"`, remove `web_accessible_resources`; delete the optional-permission gate/banner flow (`sidepanel.tsx:469-482`, `StoragePermissionBanner`, `usePermissions`)
- [x] 7.4 Enforce HTTPS for non-loopback server/PagePocket URLs at client construction (fail fast, not warn) (`server-client.ts:1056-1069`, `server-download.ts:422-436`)

## 8. Hygiene & tooling

- [x] 8.1 Delete dead code: `StreamingDownloader`, `streamingFetch`, `streaming/*`, `chunkedZip`, `progressPersistence`, `download-services`, `ports/**`, `connection.ts`, `functions.ts` (after salvaging listeners), `components/popup/**`, legacy `components/sidepanel/**`, `popup.tsx`, `popup.html`, `components/ui/**`, `lib/utils.ts`; remove jest config in favor of vitest
- [ ] 8.2 Remove the 8 phantom dependencies from `package.json` (`socket.io-client`, `tailwind-merge`, `@radix-ui/*` x6) and fix the remaining `tsc --noEmit` errors; add `tsc --noEmit` to the test script
- [x] 8.3 Add ESLint (`@eslint/js` recommended + `eslint-plugin-react-hooks`) with an npm script, fix/suppress findings, restore `.husky/pre-commit` (prettier + eslint), delete `package-lock.json`
- [x] 8.4 Make the e2e test terminate reliably in non-headless mode (remove the never-resolving `finally` await) and give TEST 4 real assertions
- [x] 8.5 Add unit tests for `RequestQueue` fairness/timeout/dedup (§2) and file-handler URL resolution (§1/§3) as part of each task; keep the 194 existing tests green

## 9. Verification

- [ ] 9.1 Full suite: `npm test` (all green including new tests), `npx tsc --noEmit` (0 errors), `npm run build` (success, dist contains only shipped entries)
- [ ] 9.2 Manual smoke matrix: root page + nested page relative assets; same-basename collision page; Shift_JIS page; `@import` chain page; login-gated assets; two concurrent tabs; restricted page (chrome://) start; server-unavailable fallback; panel closed mid-download; SW kill mid-download + resume
- [ ] 9.3 Verify spec coverage: walk each spec scenario in this change and confirm an automated test or documented manual check exists
