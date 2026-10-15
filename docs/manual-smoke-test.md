# Manual smoke test — `stabilize-extension-downloads-and-ux`

Human-executed browser matrix for OpenSpec task 9.2 (intentionally **not** ticked in `tasks.md` until a human runs it).
Every scenario lists the setup, the steps, and the expected result. Scenarios marked *(spec)* map to a spec scenario routed here from `docs/spec-coverage-stabilize-extension-downloads-and-ux.md`.

## 0. Build & load

- [ ] **B1. Build.** `npm test` (runs `tsc --noEmit` + vitest, must be green), then `npm run build`.
      Expect: build succeeds; `dist/` contains `manifest.json`, `background.js`, `sidePanel.html`, `welcome.html`, `icons/`, `_locales/`, `locales/` — and **no** `popup.html`.
- [ ] **B2. Load unpacked.** Chrome ≥ 116 → `chrome://extensions` → Developer mode → *Load unpacked* → select `dist/`.
      Expect: extension "Web Page Downloader" loads without errors, no warnings about permissions or `web_accessible_resources`.
- [ ] **B3. Pin & open panel.** Pin the toolbar icon; hover it.
      Expect: tooltip is localized (not the raw key `extensionActionTitle`). Click → side panel opens with the download form enabled.

## 1. Root page + nested page relative assets *(spec: asset-rewrite-correctness)*

- [ ] **M1. Root page.** Start a download on `https://<test-site>/index.html` with images/styles.
      Expect: ZIP completes; images/styles present; completion report shows zero failures.
- [ ] **M2. Nested page.** On `https://<test-site>/dir/page.html` which references `img/x.png` (relative):
      Expect: `x.png` is fetched from `/dir/img/x.png` (open the uploaded/ZIP paths — file must exist at `images/dir/img/x.png`-style path, not a 404 placeholder), and the completion report lists no failed images.

## 2. Same-basename collision page *(spec: collision-free archive paths)*

- [ ] **M3.** Use a page with `/a/main.css` and `/b/main.css` (identical basenames, different directories).
      Expect: both stylesheets appear in the archive under distinct paths (`css/a/main.css`, `css/b/main.css` or equivalent), each with its own content; page renders with both applied after unpack.

## 3. Shift_JIS page *(spec: charset-aware text decoding)*

- [ ] **M4.** Download a page whose stylesheet is served as `Content-Type: text/css; charset=Shift_JIS` and contains Japanese text.
      Expect: the archived CSS opens with correct Japanese characters (no mojibake `æ—¥æœ¬`-style sequences), in a browser or editor set to Shift_JIS.

## 4. @import chain page *(spec: imported stylesheets captured)*

- [ ] **M5.** Page → `main.css` → `@import url("theme.css")` → `theme.css` → `@import "reset.css"`.
      Expect: `theme.css` **and** `reset.css` are both present in the archive; a cycle (`a.css` ⇄ `b.css`) terminates — each downloaded exactly once, download completes.

## 5. Login-gated assets *(spec: credentialed fetches)*

- [ ] **M6.** Log into a site whose images/CDN assets require the session cookie. Start a download from a page referencing such assets.
      Expect: logged-in assets download successfully (files are real images, not error pages). One deliberately-404 asset shows up in the failure report without breaking the download.

## 6. Two concurrent tabs *(spec: concurrent-downloads)*

- [ ] **M7.** Start a linked-page download on tab A (site 1), then immediately start another on tab B (site 2).
      Expect: both progress independently; both ZIPs complete with their own files (no filenames from site 1 inside site 2's archive and vice versa); stopping tab A's download does not stop tab B's.

## 7. Restricted page (chrome://) start *(spec: page-compat-handling)*

- [ ] **M8.** Open `chrome://settings`, then the panel.
      Expect: panel shows the unsupported-page state ("this page can't be downloaded"-type message) and the Start control is disabled — no download can be attempted.
- [ ] **M9.** Switch the active tab to `https://example.com/` while the panel is open.
      Expect: panel re-evaluates and shows the enabled form without reopening it.
- [ ] **M10.** (Defense in depth) If a download is somehow started on a restricted/PDF-viewer tab, it fails within seconds with a visible error — no indefinite spinner.

## 8. Server-unavailable fallback *(spec: download-ux-feedback / lifecycle)*

- [ ] **M11.** Stop the PagePocket server (or point the build at an unreachable URL), start a download.
      Expect: after retries the panel surfaces a distinct server-unavailable failure (not a generic silent loop); where a local fallback exists, both **Retry** and a translated **"Download locally instead"** action with its warning are shown; using the fallback produces a local download. Where no fallback exists, only Retry is offered.

## 9. Panel closed mid-download *(spec: enveloped notifications)*

- [ ] **M12.** Start a longer download, close the side panel mid-scrape, wait, reopen it.
      Expect: no unhandled-rejection noise breaks the download (check `chrome://extensions` → service worker console is clean of `Unchecked runtime errors`); on reopen the panel shows current progress or, if it was interrupted, the resume affordance.

## 10. Service-worker kill mid-download + resume *(spec: scrape-checkpoint / lifecycle)*

- [ ] **M13.** Start a multi-page download; from `chrome://extensions` click the service-worker "stop"/restart the worker mid-download.
      Expect: on next panel open the interrupted-download state appears (push or on-open discovery) with a **Resume** affordance.
- [ ] **M14.** Kill the server mid-download, then attempt Resume while the server is still down.
      Expect: resume fails transiently, the checkpoint is **kept** — reopening the panel still offers Resume.
- [ ] **M15.** Bring the server back and Resume (or force an expired-session resume).
      Expect: on success the checkpoint is cleared (Resume no longer offered); with a definitively expired/invalid session the checkpoint is cleared and the panel offers **Restart** instead.

## 11. First-run & onboarding *(spec: extension-onboarding)*

- [ ] **M16.** Remove the extension, load `dist/` again (fresh install).
      Expect: the welcome page (`welcome.html`) opens exactly once, explains the extension and the 3-step flow, and directs to the side panel. Restarting the browser does **not** reopen it.
- [ ] **M17.** Trigger an update (bump version, reload unpacked).
      Expect: welcome page does **not** open on `"update"`.
- [ ] **M18.** No permission gate: the panel's download form is fully usable right after install with no full-screen permission request.

## 12. UX feedback details *(spec: download-ux-feedback)*

- [ ] **M19.** Stop a download mid-scrape with partial packaging: panel communicates "Saving what we captured…", the completion report is marked **partial**, and per-category failed/skipped counts are visible. A fully clean download shows a green report.
- [ ] **M20.** A full cancel (not stop-and-save) shows the localized cancelled state before returning to ready.
- [ ] **M21.** PagePocket announcement: "Maybe Later" / close persists — reopening the panel does not re-show it.
- [ ] **M22.** A11y spot-check: no duplicate form ids (unique `singleFile`), advanced-config toggle reports `aria-expanded` and collapsed controls are not tabbable, language listbox responds to ArrowDown/ArrowUp/Escape.

## 13. Security spot-checks *(spec: extension-security-hardening)*

- [ ] **M23.** After a session with an authenticated server/PagePocket, close and reopen the browser: `chrome.storage.local` contains **no** API key or auth tokens (DevTools → Application → Storage → chrome.storage.local on the extension); the next server call transparently re-registers.
- [ ] **M24.** From a normal website's DevTools, request `chrome-extension://<id>/locales/en.json` → denied (not web-accessible).
- [ ] **M25.** `dist/manifest.json` has `minimum_chrome_version: "116"`, `storage` + `alarms` in `permissions`, and no `web_accessible_resources`.
