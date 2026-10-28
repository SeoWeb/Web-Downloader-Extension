# Manual smoke test — `stabilize-extension-downloads-and-ux`

Human-executed browser matrix for OpenSpec task 9.2 (intentionally **not** ticked in `tasks.md` until a human runs it).
Every scenario lists the setup, the steps, and the expected result. Scenarios marked _(spec)_ map to a spec scenario routed here from `docs/spec-coverage-stabilize-extension-downloads-and-ux.md`.

## Automation status

Two browser suites automate the load/render/i18n slice and the download-pipeline slice of this matrix. Run commands (repo root):

```sh
# Load / render / i18n slice against the EXISTING dist/ build (B1, B2, B3, M8, M9, M16, M18, M21, M22, M24, M25):
HEADLESS=true node tests/e2e/ui-smoke.test.cjs

# Full download pipeline against a recording mock server + fixture site (M1-M7 partials):
HEADLESS=true node tests/e2e/download-pipeline.test.cjs
E2E_REBUILD=1 E2E_CONCURRENT=1 HEADLESS=true node tests/e2e/download-pipeline.test.cjs   # + concurrent tabs (R9 → M7)
```

Per-scenario automation status is annotated inline below: _(automated: …)_ = fully covered by a suite scenario, _(partial: …)_ = the cited scenario covers part of the row, _(manual)_ = no automation — needs this human pass.

## 0. Build & load

- [ ] **B1. Build.** `npm test` (runs `tsc --noEmit` + vitest, must be green), then `npm run build`.
      Expect: build succeeds; `dist/` contains `manifest.json`, `background.js`, `sidePanel.html`, `welcome.html`, `icons/`, `_locales/`, `locales/` — and **no** `popup.html`.
      _(partial: `npm test` is the unit gate; dist contents + manifest floor are asserted by ui-smoke `S1a-build-integrity` — but it does not rebuild, so the build step itself stays manual.)_
- [ ] **B2. Load unpacked.** Chrome ≥ 116 → `chrome://extensions` → Developer mode → _Load unpacked_ → select `dist/`.
      Expect: extension "Web Page Downloader" loads without errors, no warnings about permissions or `web_accessible_resources`.
      _(automated: ui-smoke `S1b-service-worker` + `S1c-extensions-listing` — SW target appears, stays alive, console clean, extension listed and enabled.)_
- [ ] **B3. Pin & open panel.** Pin the toolbar icon; hover it.
      Expect: tooltip is localized (not the raw key `extensionActionTitle`). Click → side panel opens with the download form enabled.
      _(partial: ui-smoke `S2-panel-direct-load` + `S4-supported-page` cover the panel rendering with an enabled form; the toolbar-pin/tooltip interaction itself is not automatable — manual.)_

## 1. Root page + nested page relative assets _(spec: asset-rewrite-correctness)_

- [ ] **M1. Root page.** Start a download on `https://<test-site>/index.html` with images/styles.
      Expect: ZIP completes; images/styles present; completion report shows zero failures.
      _(partial: download-pipeline R8 proves the full completion path ends with a ZIP on disk; the run uses the nested fixture page and does not assert report contents, so a distinct root-page run + report inspection stays manual.)_
- [ ] **M2. Nested page.** On `https://<test-site>/dir/page.html` which references `img/x.png` (relative):
      Expect: `x.png` is fetched from `/dir/img/x.png` (open the uploaded/ZIP paths — file must exist at `images/dir/img/x.png`-style path, not a 404 placeholder), and the completion report lists no failed images.
      _(automated: download-pipeline R1 — "relative URLs resolved against the document URL" — asserts the `/dir/img/x.png` fetch + `images/dir/img/x.png` upload and that no host-root-joined fetch is attributable to the session.)_

## 2. Same-basename collision page _(spec: collision-free archive paths)_

- [ ] **M3.** Use a page with `/a/main.css` and `/b/main.css` (identical basenames, different directories).
      Expect: both stylesheets appear in the archive under distinct paths (`css/a/main.css`, `css/b/main.css` or equivalent), each with its own content; page renders with both applied after unpack.
      _(automated: download-pipeline R2 — distinct archive paths with distinct "ALPHA"/"BETA" contents; the post-unpack render check stays manual.)_

## 3. Shift_JIS page _(spec: charset-aware text decoding)_

- [ ] **M4.** Download a page whose stylesheet is served as `Content-Type: text/css; charset=Shift_JIS` and contains Japanese text.
      Expect: the archived CSS opens with correct Japanese characters (no mojibake `æ—¥æœ¬`-style sequences), in a browser or editor set to Shift_JIS.
      _(automated: download-pipeline R3 — uploaded bytes decode as intact 日本語テキスト with no mojibake/replacement chars; the "open in an editor set to Shift_JIS" step is implied and stays manual.)_

## 4. @import chain page _(spec: imported stylesheets captured)_

- [ ] **M5.** Page → `main.css` → `@import url("theme.css")` → `theme.css` → `@import "reset.css"`.
      Expect: `theme.css` **and** `reset.css` are both present in the archive; a cycle (`a.css` ⇄ `b.css`) terminates — each downloaded exactly once, download completes.
      _(automated: download-pipeline R4 — the /css/a.css → b.css → c.css chain is fetched and uploaded; the cycle variant is covered by the unit suite (`css-handler.test.ts`), not e2e.)_

## 5. Login-gated assets _(spec: credentialed fetches)_

- [ ] **M6.** Log into a site whose images/CDN assets require the session cookie. Start a download from a page referencing such assets.
      Expect: logged-in assets download successfully (files are real images, not error pages). One deliberately-404 asset shows up in the failure report without breaking the download.
      _(partial: download-pipeline R7 asserts fixture fetches carry the session cookie, the deliberate 404 does not break the run, and the slow asset times out cleanly; a real logged-in-site pass stays manual.)_

## 6. Two concurrent tabs _(spec: concurrent-downloads)_

- [ ] **M7.** Start a linked-page download on tab A (site 1), then immediately start another on tab B (site 2).
      Expect: both progress independently; both ZIPs complete with their own files (no filenames from site 1 inside site 2's archive and vice versa); stopping tab A's download does not stop tab B's.
      _(partial: download-pipeline R9 (`E2E_CONCURRENT=1`) — two tabs finalize into distinct sessions, both polled to ready, ZIPs served per session; "stop A does not stop B" is not asserted e2e and stays manual.)_

## 7. Restricted page (chrome://) start _(spec: page-compat-handling)_

- [ ] **M8.** Open `chrome://settings`, then the panel.
      Expect: panel shows the unsupported-page state ("this page can't be downloaded"-type message) and the Start control is disabled — no download can be attempted.
      _(automated: ui-smoke `S3-unsupported-page`.)_
- [ ] **M9.** Switch the active tab to `https://example.com/` while the panel is open.
      Expect: panel re-evaluates and shows the enabled form without reopening it.
      _(automated: ui-smoke `S4-supported-page` — re-evaluation on tab switch without reopening.)_
- [ ] **M10.** (Defense in depth) If a download is somehow started on a restricted/PDF-viewer tab, it fails within seconds with a visible error — no indefinite spinner.
      _(manual.)_

## 8. Server-unavailable fallback _(spec: download-ux-feedback / lifecycle)_

- [ ] **M11.** Stop the PagePocket server (or point the build at an unreachable URL), start a download.
      Expect: after retries the panel surfaces a distinct server-unavailable failure (not a generic silent loop); where a local fallback exists, both **Retry** and a translated **"Download locally instead"** action with its warning are shown; using the fallback produces a local download. Where no fallback exists, only Retry is offered.
      _(manual — the fallback state machine is unit-covered (`server-download.test.ts` / `server-mode-state.test.ts`), but the panel rendering + fallback download flow is not automated.)_

## 9. Panel closed mid-download _(spec: enveloped notifications)_

- [ ] **M12.** Start a longer download, close the side panel mid-scrape, wait, reopen it.
      Expect: no unhandled-rejection noise breaks the download (check `chrome://extensions` → service worker console is clean of `Unchecked runtime errors`); on reopen the panel shows current progress or, if it was interrupted, the resume affordance.
      _(manual — ui-smoke `S1b-service-worker` / `S7-console-sweep` only prove a clean SW console WITHOUT a download in flight.)_

## 10. Service-worker kill mid-download + resume _(spec: scrape-checkpoint / lifecycle)_

- [ ] **M13.** Start a multi-page download; from `chrome://extensions` click the service-worker "stop"/restart the worker mid-download.
      Expect: on next panel open the interrupted-download state appears (push or on-open discovery) with a **Resume** affordance.
      _(manual — checkpoint lifecycle is unit-covered (`resume-checkpoint-lifecycle.test.ts`); the in-browser kill/resume flow is not.)_
- [ ] **M14.** Kill the server mid-download, then attempt Resume while the server is still down.
      Expect: resume fails transiently, the checkpoint is **kept** — reopening the panel still offers Resume.
      _(manual — unit-covered by `resume-checkpoint-lifecycle.test.ts : keeps the checkpoint on transient failure…`; browser pass still needed.)_
- [ ] **M15.** Bring the server back and Resume (or force an expired-session resume).
      Expect: on success the checkpoint is cleared (Resume no longer offered); with a definitively expired/invalid session the checkpoint is cleared and the panel offers **Restart** instead.
      _(manual — same unit coverage as M14; browser pass still needed.)_

## 11. First-run & onboarding _(spec: extension-onboarding)_

- [ ] **M16.** Remove the extension, load `dist/` again (fresh install).
      Expect: the welcome page (`welcome.html`) opens exactly once, explains the extension and the 3-step flow, and directs to the side panel. Restarting the browser does **not** reopen it.
      _(partial: ui-smoke `S6b-welcome-page` asserts the rendered 3-step content; "opens exactly once / not on update" stays manual (M17).)_
- [ ] **M17.** Trigger an update (bump version, reload unpacked).
      Expect: welcome page does **not** open on `"update"`.
      _(manual.)_
- [ ] **M18.** No permission gate: the panel's download form is fully usable right after install with no full-screen permission request.
      _(automated: ui-smoke `S4-supported-page` — enabled Start control + form with no permission gate.)_

## 12. UX feedback details _(spec: download-ux-feedback)_

- [ ] **M19.** Stop a download mid-scrape with partial packaging: panel communicates "Saving what we captured…", the completion report is marked **partial**, and per-category failed/skipped counts are visible. A fully clean download shows a green report.
      _(manual.)_
- [ ] **M20.** A full cancel (not stop-and-save) shows the localized cancelled state before returning to ready.
      _(manual.)_
- [ ] **M21.** PagePocket announcement: "Maybe Later" / close persists — reopening the panel does not re-show it.
      _(partial: ui-smoke `S6a-announcement-persistence` exercises this, but its visibility check is case-sensitive (`"New Feature"` vs the CSS-uppercased `NEW FEATURE`), so it currently reports SKIPPED even though the announcement renders (verified by runtime probe, Oct 2026 — see task notes); run the persistence path manually until that check is fixed.)_
- [ ] **M22.** A11y spot-check: no duplicate form ids (unique `singleFile`), advanced-config toggle reports `aria-expanded` and collapsed controls are not tabbable, language listbox responds to ArrowDown/ArrowUp/Escape.
      _(partial: ui-smoke `S6d-a11y` — duplicate ids, aria-expanded toggle, listbox ArrowDown/Escape; collapsed-control tabbability + ArrowUp stay manual.)_

## 13. Security spot-checks _(spec: extension-security-hardening)_

- [ ] **M23.** After a session with an authenticated server/PagePocket, close and reopen the browser: `chrome.storage.local` contains **no** API key or auth tokens (DevTools → Application → Storage → chrome.storage.local on the extension); the next server call transparently re-registers (the server rejects an ID-only re-registration of a registered instance with 409 `reauth_required` — api-abuse-hardening — so recovery rotates to a fresh instance ID and registers as a new client).
      _(manual — the storage-partitioning itself is unit-covered (`server-client.test.ts` / `pagepocket-client.test.ts` session-storage assertions).)_
- [ ] **M24.** From a normal website's DevTools, request `chrome-extension://<id>/locales/en.json` → denied (not web-accessible).
      _(automated: ui-smoke `S6c-web-accessible-probe`.)_
- [ ] **M25.** `dist/manifest.json` has `minimum_chrome_version: "116"`, `storage` + `alarms` in `permissions`, and no `web_accessible_resources`.
      _(partial: ui-smoke `S1a-build-integrity` asserts exactly these manifest properties against the existing dist/.)_
