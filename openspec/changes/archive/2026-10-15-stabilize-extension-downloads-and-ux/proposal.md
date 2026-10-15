## Why

A deep audit (Oct 2026) of the extension found that downloads do **not** work in all cases: two memory-manager bugs permanently stall the request queue, a missing promise-rejection path hangs the UI forever on restricted pages, relative asset URLs are resolved against the site origin (breaking every non-root page), and the dedup cache hands out already-consumed responses. Beyond correctness, the audit found a critical security issue (the extension signing key `dist.pem` is committed to git), a broken translation pipeline (raw i18n keys visible to users in 46 locales), no first-run experience, and large islands of dead code that mask missing dependencies. These are ship blockers and high-frequency user-facing failures.

## What Changes

**P0 — Ship blockers**
- Fix `MemoryManager` accounting leak (`queueResource` records never matched by `releaseResource`) that permanently stalls the queue after ~425 MB cumulative traffic
- Fix string comparison of `MemoryPressureLevel` enum (lexicographic `>=` inverts the pressure ladder; safety net fires on LOW and never on CRITICAL)
- Add `.catch`/`reject` to `executeScript` wrapper so injection failures (chrome://, PDF viewer, Web Store, crashed tabs) surface as errors instead of hanging forever
- Resolve relative asset URLs against the **document URL**, not the tab origin (css/js/images file handlers)

**P1 — Download correctness**
- Make the `RequestQueue` dedup cache store bytes/text (not a consumed `Response`) so duplicate URL references succeed
- Enforce a real fetch timeout (currently `requestTimeout` is never used) and apply it via `AbortSignal`
- Send credentials (`credentials: "include"`) on asset fetches so logged-in/private CDN assets download; skip opaque (no-cors) responses in image/js handlers instead of throwing
- Fix head-of-line blocking: allow non-blocked domains to proceed when the queue head's domain is rate-limited
- Preserve directory structure (or hash suffix) for css/js/documents filenames to stop same-basename collisions silently overwriting ZIP content
- Decode CSS/text with the response charset instead of always UTF-8; extract and download `@import`ed stylesheets and favicons
- Filter out `blob:`/`chrome-extension:`/`data:` asset URLs before enqueueing; stop enqueuing `<a href>` targets as HTML in non-full linked-page mode
- Scope the global image filename map and `ServerDownloadHandler` polling controller per download so two concurrent tabs cannot corrupt each other
- Retry HTML chunk uploads via `withRetry`; clear the resume checkpoint only **after** a successful resume
- Replace ineffective `setInterval`/`activate` cleanup with `chrome.alarms`; register cleanup listeners once; send interrupted-download push with the proper `target` envelope; stop unhandled rejections when the panel is closed mid-download

**P2 — UX**
- Fix translation pipeline: add missing popup keys to all locales, add missing PagePocket/cloud keys to all non-en locales, add `status.finalizingPartial` to en, add a CI locale-coverage check
- Add a real first-run experience (built welcome page opened on install) and remove or properly build the dead popup/welcome tree
- Pre-validate the active tab and show a friendly "this page can't be downloaded" state instead of failing after the click
- Wire the already-translated local-fallback action on server failure (currently retry-only dead end); persist per-category asset-failure summaries to the completion screen; persist PagePocket announcement dismissal
- Stop blocking the whole app on the optional `storage` permission (promote to required); a11y fixes (duplicate checkbox id, `aria-expanded`, listbox keyboard nav, RTL cleanup)

**P3 — Security & hygiene**
- Remove `dist.pem`/`dist.crx` from git and from history (key rotation guidance); move auth/API-key storage to `chrome.storage.session`; remove `web_accessible_resources` exposure of locales; add `minimum_chrome_version: "116"`
- Delete dead code (streaming subsystem, ports subsystem, `download-services`, `functions.ts` stubs, legacy sidepanel/popup) which also removes 8 phantom dependencies; fix all 23 `tsc --noEmit` errors; remove dual lockfiles; add ESLint; fix husky hooks path; add tests for MemoryManager, RequestQueue, and file handlers

## Capabilities

### New Capabilities
- `download-fetch-pipeline`: Correctness requirements for the shared asset fetch queue — timeouts, credentials, consumable dedup cache, opaque-response handling, and fair scheduling across domains
- `memory-safety`: Memory accounting and pressure handling for the download service worker — accurate usage tracking, correctly ordered pressure levels, queue pause/resume that can always recover
- `asset-rewrite-correctness`: URL resolution against document URLs, charset decoding, `@import`/favicon capture, and collision-free archive paths for CSS, JS, images, and documents
- `page-compat-handling`: Bounded, error-surfacing behavior when the active tab cannot be scripted (browser pages, crashed/discarded tabs) with a friendly unsupported-page state in the panel
- `download-lifecycle-reliability`: Service-worker-lifecycle resilience — `chrome.alarms`-based cleanup, single listener registration, enveloped panel notifications, retryable HTML chunk uploads, checkpoint cleared only after successful resume
- `extension-security-hardening`: Signing-key hygiene, token storage location, minimal permissions, and manifest hardening
- `extension-onboarding`: First-run experience, single coherent UI surface, and locale key coverage guarantees
- `download-ux-feedback`: User-facing feedback completeness — local fallback on server failure, persistent failure summaries, dismissal persistence, explicit cancellation states, accessibility fixes

### Modified Capabilities
- `concurrent-downloads`: Extend per-tab isolation to **all** shared mutable state (global image filename map, assembly polling controller) so concurrent tab downloads cannot corrupt each other
- `scrape-checkpoint`: Checkpoint lifecycle changes — checkpoint is cleared only after a successful resume attempt, preserving recovery state on failure

## Impact

- **Code**: `src/utils/MemoryManager.ts`, `src/utils/memoryLimits.ts`, `src/utils/RequestQueue.ts`, `src/utils/ThrottlingManager.ts`, `src/utils/DomainLimiter.ts`, `src/background/fileHandlers/*`, `src/background/download-core.ts`, `src/background/server-download.ts`, `src/background/linked-page-scraper.ts`, `src/background/cleanupHandlers.ts`, `src/background/download-checkpoint.ts`, `src/background/message.ts`, `src/background/server-client.ts`, `src/common/chrome.ts`, `src/background.js`, `src/sidepanel.tsx`, `src/components/*`, `public/manifest.json`, `public/_locales/*`, `src/i18n/locales/*`
- **Repo/security**: `dist.pem`, `dist.crx` removal + history purge; lockfile consolidation; ESLint + husky introduction
- **Build**: vite inputs (welcome page add or popup/welcome removal), CI additions (tsc, locale coverage)
- **Dependencies**: removal of phantom deps resolves 8 of 23 type errors; no new runtime dependencies planned
- **Server**: no server API changes required (all changes are extension-side)
