## Context

The extension is a **server-mode-only** MV3 website downloader: the side panel scrolls the page and streams HTML chunks to the server; the background fetches every discovered asset through a shared `RequestQueue` and uploads bytes via `UploadQueue`; the server assembles the ZIP and the extension downloads it via `chrome.downloads`. A `chrome.storage.session` checkpoint plus a resume flow recover from service-worker death.

The Oct 2026 audit found:
- Two `MemoryManager` defects (accounting leak + lexicographic comparison of the pressure enum) that together permanently stall downloads and poison subsequent downloads until the SW restarts.
- An `executeScript` wrapper with no rejection path (`src/common/chrome.ts`) that hangs the UI forever on restricted pages.
- Relative asset URLs resolved against `origin` instead of the document URL in all three file handlers — most real-world pages are not at the domain root.
- A dedup cache returning consumed `Response` objects, no fetch timeout, no cookies on cross-origin fetches, opaque-response crashes, head-of-line blocking, basename-only archive paths, UTF-8-only text decoding, and shared mutable globals (image filename map, polling controller) that corrupt concurrent tab downloads.
- Security/hygiene debt: `dist.pem` committed, tokens in `chrome.storage.local`, optional `storage` permission with ~50 unguarded calls, 8 phantom dependencies, 23 `tsc` errors, no ESLint, broken husky path, and a broken translation pipeline (raw keys visible in 46 locales).

Constraints: no server API changes; keep the existing server protocol and session/resume model; keep behavior of the tested server-mode paths (`upload-queue`, `server-client`) stable — they are the only well-covered code.

## Goals / Non-Goals

**Goals:**
- Downloads work correctly on all page types, depths, encodings, and concurrent-tab scenarios the pipeline already claims to support.
- Every failure mode surfaces as a bounded error to the user (never an infinite hang or silent stall).
- The archive matches the page: correct URLs, correct bytes/charset, no silent overwrites.
- User-facing feedback is complete: unsupported pages, server failure fallback, failure summaries, cancellation.
- Security hygiene: no signing keys in git, tokens in session storage, minimal permissions, manifest hardening.
- Repo health: `tsc --noEmit` clean, ESLint + working hooks, dead code removed, locale key coverage enforced.

**Non-Goals:**
- Local ZIP generation (the streaming/`chunkedZip` subsystem stays deleted, not revived).
- Capturing JS-executed/dynamic assets, iframe content, or scroll-states beyond current behavior.
- Server-side assembly, conversion, or API changes.
- A full accessibility audit beyond the concrete defects listed in the specs.
- Translating all 46 locales by hand — missing non-en keys fall back to English; the CI check prevents regressions.

## Decisions

### D1. Memory: fix accounting instead of deleting MemoryManager
`trackResourceAllocation`/`releaseResource` move into the `RequestQueue` item lifecycle (allocate when a request actually executes with its `Content-Length`, release in the request's `finally`), replacing the mismatched `queueResource`/`processQueue` bookkeeping. `MemoryPressureLevel` gains an explicit numeric rank (`{low:0, medium:1, high:2, critical:3}`) and all comparisons use the rank. `forceCleanup` resets `currentUsage` from live state.
*Why not delete MemoryManager?* The download gate (`download-core.ts:118`) and `ThrottlingManager` pause/resume depend on it; deletion widens the blast radius. The fix is local and testable.
*Alternative considered:* remove the pause/resume entirely and rely on `DomainLimiter` — rejected: no defense against genuine memory pressure with 12-way upload concurrency.

### D2. URL resolution: thread the document URL through the pipeline
`processImages/processAssets/processDocuments` already receive the page URL; handlers change `new URL(raw, origin + "/")` to `new URL(raw, documentUrl)`. Linked-page processing passes each linked page's URL as its document URL, which also aligns the dedup filter (`linked-page-scraper.ts`) with the fetchers because both now resolve the same string against the same base.
*Alternative considered:* absolutizing in the content script before serialization — rejected: would alter the archived HTML and require server-side rewrite coordination.

### D3. Dedup cache: cache a snapshot, not a `Response`
`RequestResult` stores `{ ok, status, headers, bytes | text, contentType }`. Consumers get a fresh `Response` (or direct bytes/text) per call. Responses over a size cap (5 MB) are not cached — the second reference re-fetches.
*Alternative considered:* `response.clone()` per waiter — rejected: clones share a stream; late subscribers after the body is read still fail, and it complicates cancellation.

### D4. Fetch hardening in `RequestQueue`
- Timeout: an `AbortSignal.any([externalSignal, AbortSignal.timeout(requestTimeout)])`-style composite per request; `requestTimeout` (30 s) becomes real.
- Credentials: primary fetch uses `credentials: "include"` (host permissions are granted for `<all_urls>`, so this is permitted and fixes logged-in/private-CDN assets).
- Opaque responses: `executeRequest` returns `response.type === "opaque"` flagged; image/js handlers skip with a categorized "cors" failure instead of throwing; CSS treats opaque as failure (text unreadable).
- Fairness: the processing loop no longer `break`s when the head request's domain limiter is saturated — it scans for the next processable request (round-robin), eliminating head-of-line blocking and the 10 ms busy-spin.
- `DomainLimiter` recovers to the actual configured default rate; `retryAfter` is threaded into `adjustRateLimit`; robots `Crawl-delay` is read only from the `*` group.
*Note:* keep the `no-cors` fallback, but only for cacheable/usable cases (images), never for text.

### D5. Archive paths: preserve directory structure
CSS/JS/documents/images upload to `assets/<sanitized-pathname>` (query string hashed into the filename as today) instead of basename-only. `ServerStorageAdapter` path-dedup then becomes correct instead of silently overwriting. Registry paths use the same key builder (`buildArchivePath`) so `AssetRegistry` metadata becomes consistent.
*Migration:* none needed server-side; paths within a single session are self-consistent.

### D6. Charset + `@import` + favicons
CSS text decodes via `TextDecoder` using the `Content-Type` charset, else the `@charset` rule, else UTF-8. `@import` rules (url and string forms) are extracted recursively with a depth cap of 3 and a per-download dedup. `link rel=icon|apple-touch-icon|shortcut icon` joins the image extraction list.
*Why here and not the server?* The server can only rewrite what was uploaded; extraction is extension-side.

### D7. Per-download context replaces shared globals
`downloadResources` creates a `DownloadContext` (filename map, dedup keys, abort controller, upload queue, polling controller) and threads it through processors, handlers, and the scraper. `ServerDownloadHandler.pollAssemblyStatus` accepts a caller-supplied `AbortSignal` keyed by session instead of a singleton controller field. This completes what the `concurrent-downloads` spec already requires for per-tab state.
*Alternative considered:* a Map keyed by tabId for the globals — rejected: a context object is explicit, testable, and cannot leak entries.

### D8. Bounded scripting: reject instead of hang
`executeScriptWithCatch` wraps `chrome.scripting.executeScript` with `.catch(err => reject(err))` and resolves `{success:false}` when all injection results are falsy. `useActiveTabInfo` pre-validates the URL (`https?` only, not chrome://, edge://, chrome-extension://, Web Store, file:// without access) and the panel renders a friendly unsupported state with the form disabled *before* Start.

### D9. Lifecycle: `chrome.alarms` + single registration + enveloped pushes
Periodic cleanup moves to `chrome.alarms` (1-minute periodic alarm + `onAlarm` handler); the duplicate `setTimeout` registration is removed (register once at module import). All background→panel messages go through `sendMessageToPanel` (correct `target` envelope) and every `sendMessage` promise is `.catch`-ed so a closed panel is a no-op, not an unhandled rejection. The `background.js` interrupted-download push switches to the enveloped helper.

### D10. Resume keeps its checkpoint until the outcome is known
`RESUME_SERVER_DOWNLOAD` reads the checkpoint, runs the resume, and clears it only on success or definitive failure (expired/invalid session). On transient failure the checkpoint stays so the panel can offer Retry after reopen. Server-side session state (not the panel's memory) is the source of truth for interrupt recovery.

### D11. Security hardening
- Forward-fix the key leak: delete `dist.pem`/`dist.crx` from the repo and add them to `.gitignore`; document (and execute) key rotation with CWS re-upload in a runbook. Full history rewrite (git filter-repo) is prepared as an ops task because it rewrites all SHAs and must be coordinated with clones/CI.
- PagePocket auth state and server API key move to `chrome.storage.session` (pattern already used by the checkpoint). Trade-off: re-auth/re-register per browser start — accepted; both flows are automatic.
- `storage` becomes a **required** permission; the optional-permission gate, banner request flow, and unguarded-call hazard all disappear. (Triggers one re-approval prompt on update — accepted, no install warning exists for `storage` anyway.)
- Remove `web_accessible_resources`; add `minimum_chrome_version: "116"`; block (not warn) non-HTTPS server URLs except localhost/127.0.0.1.

### D12. Dead code removal + type/CI health
Delete: `src/utils/StreamingDownloader.ts`, `src/utils/streamingFetch.ts`, `src/utils/streaming/*`, `src/utils/chunkedZip.ts`, `src/utils/progressPersistence.ts`, `src/background/download-services.ts`, `src/background/ports/**`, `src/background/connection.ts`, `src/background/functions.ts` (after salvaging empty-stub listeners), `src/components/popup/**`, `src/components/sidepanel/**` (legacy), `src/popup.tsx`, `popup.html`, `src/components/ui/**`, `src/lib/utils.ts` (with `tailwind-merge`), plus jest config in favor of vitest. This removes the 8 phantom dependencies and ~half the `tsc` errors; the remaining 15 errors are fixed in place. Add `tsc --noEmit` to the test script, add minimal ESLint (`@eslint/js` recommended + react-hooks), restore `.husky/pre-commit`, delete `package-lock.json`.

### D13. i18n pipeline
Single source of truth: `src/i18n/locales/en.json`. A sync script copies missing keys into the other locale files (English fallback values) and a vitest/CI check fails when (a) any `t()` key in `src/` is absent from `en.json`, or (b) any locale is missing keys present in `en.json`. `status.finalizingPartial` and the 26 cloud/PagePocket keys are added to `en.json` and propagated. The chrome.i18n `_locales` files shrink to the manifest-required minimum (name/description/title) since the popup is removed.

### D14. UX feedback completion
- Local fallback: `DownloadStatus` renders "Download locally instead" wired to `canFallback` (returns the server ZIP URL or triggers a server-side assemble-and-redirect), using the existing translated strings.
- Failure summary: background already emits per-category summaries; the panel aggregates them into state and `DownloadComplete` renders a persistent "Download report" block.
- Announcement: "Maybe Later"/X persist the dismissal to `chrome.storage.local`.
- Stop: partial-save path shows "Saving what we captured…" and the completion report marks the download as partial; a full cancel shows `status.cancelled`.
- Tab switch: `tabs.onActivated` refreshes panel tab info; messages for other tabs are ignored (existing filter applies).

## Risks / Trade-offs

- **[D4 `credentials: "include"`]** Sending cookies may change behavior on CDNs that vary responses by cookie. → Mitigation: fall back to `credentials: "omit"` on 4xx when the credentialed attempt fails.
- **[D11 required `storage` permission]** Chrome disables the extension until the user re-approves the updated permissions. → Mitigation: coordinate with the release notes; the alternative (optional + guards everywhere) permanently keeps silent-failure modes.
- **[D11 tokens in `session` storage]** Users re-authenticate PagePocket after every browser restart. → Mitigation: automatic re-registration makes this invisible for the API key; PagePocket login is a rare action.
- **[History purge]** Rewriting SHAs breaks clones and open PRs. → Mitigation: runbook task is separate from code changes; forward-fix (delete + rotate) ships first.
- **[D5 path change]** Any consumer assuming flat `styles/`, `scripts/` basenames breaks. → Mitigation: server rewrite is map-driven (filename map), which is updated with the same `buildArchivePath`; covered by `server-storage-adapter` tests.
- **[D12 mass deletion]** Something unreferenced today may be planned future work (popup). → Mitigation: the deletion list is in git history and the spec pins the single-surface decision; recovery is a revert.
- **[D9 alarms minimum period]** `chrome.alarms` periods below 1 minute are clamped; cleanup cadence coarsens. → Mitigation: cleanup is idempotent and not time-critical.
- **[Regression risk on the tested server path]** `download-core` touches are extensive. → Mitigation: keep `upload-queue`/`server-client` interfaces stable; extend the existing 194-test suite with MemoryManager/RequestQueue/handler tests before refactoring them.

## Migration Plan

1. Land P0 fixes (D1, D2, D8) as isolated commits with unit tests — each is independently shippable.
2. Land fetch-pipeline hardening (D3, D4) behind the existing `RequestQueue` interface; run the full vitest suite.
3. Land archive-path/charset/`@import` (D5, D6) with the `buildArchivePath` helper first, then handler migration.
4. Land concurrency context (D7) + lifecycle (D9, D10) together — they touch the same call sites.
5. Land UX (D14) and i18n (D13) — independent of background changes.
6. Land security/manifest (D11) and hygiene (D12) last; cut a release with the re-approval warning note; execute the key-rotation runbook.
Rollback: each phase is a normal git revert; no data migration exists (sessions are ephemeral server-side).

## Open Questions

- Does the CWS account allow same-ID re-upload after key rotation (runbook must confirm before executing)?
- Should the local fallback reuse the server ZIP URL directly (fast path) or request a server-side "assemble now" for partially-uploaded sessions (needs a capability check, not a protocol change)?
- Target ESLint strictness (recommended-only vs typescript-eslint strict) — proposal assumes recommended-only to keep the diff small.
