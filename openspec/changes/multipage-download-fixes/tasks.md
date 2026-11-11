## 1. Extension — linked-page asset gating (design D1)

- [x] 1.1 Thread the normalized `downloadOptions` snapshot into the `LinkedPageScraper` builder (`download-core.ts:945`); in `downloadAssets()` (`linked-page-scraper.ts:987-1133`) gate per category exactly like `download-core.ts:824-855`: images on `downloadImages`, css/js on `downloadAssets`, documents on `downloadDocuments`
- [x] 1.2 Bite-proofed tests (prove failing at HEAD, record verbatim failures): text-only + fullScraping run fetches/uploads zero assets; images-only mode fetches images but no css/js/docs; html-on run unchanged (assets still flow); verify the `downloadHtml`-off validation path (`filterStore.ts:89-92`) combined with the snapshot yields no linked assets
- [x] 1.3 Extension vitest + `tsc --noEmit` green

## 2. Monolith — per-page content storage, slugs, zip layouts (design D4/D5/D6)

- [x] 2.1 New route `POST /api/v1/sessions/{session_id}/content/pages` (`{page_url: str | null, text: str}`; null = main): store `content_pages/<page_url_hash>.txt` (same `sha256[:16]` scheme as `html.py:146-150`), replace-on-rewrite semantics, per-request size cap inherited from the content route (`config.py:97`), counted in session size; legacy append endpoint (`sessions.py:839-875`) untouched
- [x] 2.2 Assembler read access: load a session's per-page texts keyed by `page_url_hash` (map hash → text) alongside existing content reads
- [x] 2.3 `text_zip_path_for(path)` sibling of `markdown_zip_path_for` (`zip_assembler.py:2400-2409`); slug via `generate_page_filename(page_url)` (`html_converter.py:182-223`), `<page_url_hash>.txt` fallback when no page URL was captured
- [x] 2.4 `_assemble_text_only` (`zip_assembler.py:1134-1232`): emit `index.txt` (main) + `pages/<slug>.txt` per linked page (+ `pages/<slug>.md` siblings when markdown also on); single-page text run still delivers raw `content.txt`; multi-page run → zip (existing one-raw/many-zip rule)
- [x] 2.5 Server tests: multi-page text zip layout (index.txt + pages/\*.txt); slug + deterministic collision suffix (`about.txt` / `about-c3d4.txt`); no-URL hash fallback; single-page raw regression unchanged; legacy session without `content_pages` assembles exactly as today

## 3. Extension — per-page text streaming (design D4)

- [x] 3.1 `server-client.uploadPageContent(sessionId, pageUrl | null, text)` → new endpoint; same retry policy as control-plane calls; 5 MB body cap respected
- [x] 3.2 Reorder + stream: main text uploaded first (before the linked phase opens); `linked-page-scraper` uploads each page's text immediately after its scrape (gated on `extractText`, `download-core.ts:989`); delete `accumulatedText` and the end-of-run append (`download-core.ts:1024-1041`) including the contradictory ordering comments
- [x] 3.3 Extension tests: main-first ordering; one upload call per scraped page; no whole-run text accumulation (memory-shape assertion); per-page upload failure is surfaced in failure counts without failing the run
- [x] 3.4 Extension vitest + `tsc --noEmit` green

## 4. Extension — true pause + parked state (design D2)

- [x] 4.1 Remove the 60 s `PAUSED_WATCHDOG_MS` self-stop (`linked-page-scraper.ts:95,237-248`) and the keepalive-disconnect auto-stop-while-paused (`:226-233`); pause blocks between-page advancement indefinitely (`:422-427,:522-527`)
- [x] 4.2 Tab release on pause: run `restoreOriginalPage()` immediately when pausing (not only at loop exit); resume re-acquires a tab — recreate in background when the original is gone
- [x] 4.3 Queue snapshot at pause → `chrome.storage.session`: remaining internal/external queues, visited/processed URL set, current phase, counters; 5,000-URL cap with a truncation marker; cleared on resume/stop/complete
- [x] 4.4 Checkpoint phase `paused` (`download-checkpoint.ts`); worker-wake detection routes `paused` checkpoints to the parked path
- [x] 4.5 Resume-from-park: message handler re-spawns `LinkedPageScraper` seeded from the snapshot onto the same (never finalized) server session; stop-from-park finalizes the partial via the existing salvage path
- [x] 4.6 Tests (fake timers where needed): pause holds beyond 60 s without self-stop; disconnect while paused parks (no finalize); snapshot round-trip; resume-from-park continues without re-scraping visited pages; truncation marker set beyond cap; stop-from-park delivers partial

## 5. Extension — liveness proofs + UI honesty (design D3/D9)

- [x] 5.1 Persisted liveness: replace in-memory `liveServerSessionIds` reads (`download-state.ts:247`) with a `chrome.storage.session` record (session id + heartbeat timestamp) refreshed by the existing 15 s heartbeat and poll ticks
- [x] 5.2 Guard completion: `finalizeComplete` (`livePolling.ts:66-67`) requires a fresh heartbeat or terminal server status (`ready`/`failed`/`cancelled`) — closes the service-worker-restart false "Done!"
- [x] 5.3 Interrupted-card liveness proof: the 45 s panel watchdog (`downloadWatchdog.ts`) and the startup cleanup push (`cleanupHandlers.ts:258-318`) probe `CHECK_DOWNLOAD_LIVE` + liveness freshness before declaring; phase `paused` checkpoints never produce the interrupted card
- [x] 5.4 Assembly heartbeat: periodic status push during assembly polling so long silent merges (`zip_assembler.py:230-239`) are not read as worker death
- [x] 5.5 Per-page progress counter: dedicated state from `status.linkedPageProgress` (`current/total`) rendered prominently on the scraping card (and headline suffix if chosen during implementation), not only as a message-feed subtitle
- [x] 5.6 Paused card: new server-mode phase `paused` rendering localized Paused state with Resume + Stop (`server-mode-state.ts`, `DownloadStatus.tsx`)
- [x] 5.7 Honest merge wording: when session options have `downloadHtml=false`, the `merging_html` subtitle explains the merge prepares text/markdown conversion; i18n keys ×45 locales via `scripts/sync-locales.mjs`; locale-coverage test green
- [x] 5.8 413 session-full early exit surfaces a partial-completion note (pages captured vs queue total) instead of an unqualified "Done"
- [x] 5.9 Bite-proofed tests: SW-restart simulation at HEAD produces "Done!" (record verbatim), after the fix produces wait/interrupted-not-complete; long-merge silence at HEAD fires the interrupted card, after the fix it does not; paused card render; counter render; wording per options

## 6. PagePocket backend — proto + archive-service (design D7)

- [x] 6.1 `pagepocket/proto/archive.proto`: add `message PageDocument { path, title, url, content_format, data }` + `repeated PageDocument pages` on `IngestPageRequest` + repeated pages summary on `PageResponse`; additive field numbers only; regenerate stubs via `make proto` (never hand-edit generated files)
- [x] 6.2 `archive-service/servicer.py` ingest: accept pages, store each at `{user}/{page}/pages/<path>` (asset-path slash handling already preserves the layout), record `"pages": [{path, title, url, content_format}]` in `meta.json`, include pages bytes in `size_bytes`; ingest without pages unchanged (legacy)
- [x] 6.3 `GetPage` returns the pages summary list; `ExportPage` verified unchanged (prefix listing already includes `pages/` objects — add an explicit test)
- [x] 6.4 Archive-service tests: multi-doc round-trip (html + pages/\*.md/txt); manifest fields; quota includes pages; legacy empty pages; exported zip contains the `pages/` directory

## 7. Monolith — cloud push pages + manifest (design D7; depends on §6)

- [x] 7.1 `_assemble_cloud_push` (`zip_assembler.py:1455-1459,1524-1526`): in `download_html=false` mode push linked-page markdown (`page_md_list`, `:382-388`) and per-page texts as `PageDocument`s with path/title/url/content_format; when HTML is on, pages docs accompany the html assets; `CLOUD_MAX_ASSETS` counting unaffected (documents, not assets)
- [x] 7.2 Manifest build: titles extracted from linked-page merged HTML `<title>` (merge runs unconditionally) with slug-base fallback; `archive_client.push_to_archive` signature extended
- [x] 7.3 Monolith tests: markdown-mode multi-page push carries pages documents; text-mode push carries per-page texts; manifest fields correct; legacy single-page push unchanged; byte-size pre-flight includes pages

## 8. PagePocket — gateway + viewer (design D7/D8; depends on §6)

- [x] 8.1 Gateway: `GET /archive/pages/{page_id}` detail includes the pages summary list (tolerant zod parse; absent on legacy)
- [x] 8.2 Frontend schemas/client types: optional `pages` on page detail (tolerant parse, absent = legacy)
- [x] 8.3 `page-viewer-shell.tsx`: burger button when `pages.length > 1`; sidebar lists subpages (title + host/path, active highlighted); selection swaps the main pane via `/f/pages/<path>` fetch (no-store pattern); `?page=` URL param via `router.replace(..., { scroll: false })` surviving back/forward alongside `?format=`; `public-viewer-shell` parity; single-doc pages unchanged (no burger)
- [x] 8.4 `[pageId]/page.tsx` failure split: true 404 → `notFound()` unchanged; transient failures (network/gateway/5xx) → retryable error state with Retry
- [x] 8.5 Frontend tests: burger/sidebar render + pane swap + URL param survival; single-doc no burger; retry state on transient failure; 404 unchanged; vitest + build green

## 9. Verify & ship

- [ ] 9.1 All suites green: extension (vitest + `tsc --noEmit` + `npm run build`), monolith (`cd server && python3 -m pytest -q`), pagepocket backend (`make test`), frontend (vitest + build)
- [ ] 9.2 `openspec validate multipage-download-fixes --strict`; commit with explicit paths only (never `git add -A`); push `main:main main:pagepocket`; CI green
- [ ] 9.3 Deploys: pagepocket backend + frontend via CI jobs; monolith manual rebuild only on the user's explicit order (runbook §3 step 3b); extension ships with the operator's rebuild; deploy order §6→§7→§8 before extension §1/§3-§5 where feasible (all contracts additive, partial deploys degrade safely)
- [ ] 9.4 Operator verification (rebuilt extension): (a) text-only multi-page download → zip with `index.txt` + `pages/<slug>.txt`; (b) markdown multi-page cloud download → pagepocket zip contains `pages/` dir + manifest, viewer burger sidebar swaps subpages; (c) pause holds indefinitely, Resume continues scraping, parked card appears after worker death and Resume/Stop both work; (d) long merge produces no false "Done" and no false "service was restarted"; (e) text/markdown full-scraping run uploads zero assets; (f) single-page raw `.txt`/`.md` unchanged; (g) full remove + re-add of the extension clears the `chrome.alarms` warnings (manifest re-read)
- [ ] 9.5 Tick the superseded operator-verification items (`text-native-downloads` 7.4, `download-as-markdown` 4.5) and archive this change once 9.4 passes
