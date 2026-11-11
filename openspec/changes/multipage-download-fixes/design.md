# Design: multipage-download-fixes

## Context

Every download runs through the server-mode pipeline (no local packaging exists — the monolith always assembles the artifact). Multi-page ("Full Scraping") runs drive one open server session: the main page streams HTML chunks with `pageType: "main"` during panel-side scrolling, then `LinkedPageScraper` walks subpages sequentially, uploading each page's HTML chunks (`pageType: "linked"`, `pageUrl` set → server hashes to `page_url_hash`), a delta filename map, and assets via a 12-concurrent `UploadQueue`.

Ground truth from the 2026-11-11 investigation (all refs verified at HEAD `8a85d9d` + `080810f`):

- **Assets are ungated on linked pages**: `linked-page-scraper.ts:647,987-1133` fetches images/css/js/docs unconditionally, while the main page obeys per-category flags (`download-core.ts:824-855`) and text-only normalization zeroes the flags (`filterTypes.ts:56-86`, applied in `useFilterOptions.ts:96-100`). Options are a **press-time snapshot** — the background never re-reads the store mid-run (no `chrome.storage.onChanged` listener for filter options in `src/background/`).
- **Pause is a 60 s bounded wait**: `PAUSED_WATCHDOG_MS = 60_000` (`linked-page-scraper.ts:95,237-248`) self-stops the scraper; keepalive-port disconnect while paused also auto-stops (`:226-233`). Pause only gates between-page advancement (`:422-427,:522-527`).
- **The linked-page queue, visited set, and `accumulatedText` live only in worker RAM** (`:405,:486-581`). `accumulatedText` holds every subpage's text until one end-of-run `uploadContent` append (`download-core.ts:1024-1026`), with main text appended **after** subpage text (`:1037-1041`) — the inverted order.
- **Interruption detection is heuristic, not proven**: the panel watchdog converts 45 s of message silence into "service was restarted" (`downloadWatchdog.ts:29`, `sidepanel.tsx:421-440`); the startup cleanup push converts a stale `isDownloadInProgress` flag + checkpoint into the same card with no liveness check (`cleanupHandlers.ts:258-318`). Server assembly's merge phase (`zip_assembler.py:230-239`) runs unconditionally — even for text-only and stopped sessions — and can be silent for minutes, matching the false-positive pattern the operator hit.
- **Completion can be declared from lost liveness**: `liveServerSessionIds` is an in-memory Set (`download-state.ts:247`); a service-worker kill mid-run empties it, so the 2.5 s panel poll sees `live:false + sawLive:true + no error` → `finalizeComplete` → `status.complete` → "Done!" headline (`livePolling.ts:42-72`, `Actions.tsx:59,115-124`). The only per-page progress is a subtitle message (`status.linkedPageProgress`, `en.json:210`).
- **Text/markdown collapse into single documents**: multi-page text = one concatenated `content.txt` → raw single-file delivery (`zip_assembler.py:1162-1206`), diverging from text-native design D3 ("per-page text files … land in the zip branch"). Cloud push sends only the **main page's** markdown (`zip_assembler.py:558`) and `assets = []` when `download_html` is false (`:1455-1459,:1524-1526`), so a PagePocket markdown zip is `index.md + meta.json` only. Linked-page markdown is computed (`page_md_list`, `:382-388`) but consumed only by the local-zip branch.
- **Readable slugs already exist server-side**: `generate_page_filename(url)` (`html_converter.py:182-223` — last path segment, `fix_filename` sanitization, 100-char stem cap), collisions resolved with a 4-hex hash suffix (`zip_assembler.py:345-348` → `about-c3d4.html`), and `markdown_zip_path_for` is a pure extension swap (`:2400-2409`).
- **PagePocket has no subpage concept**: one archive entry = one page; `ContentDocument` entries are _formats of the same page_ (`archive.proto:46-67`); `PageResponse` carries no page list (`:83-100`); `ExportPage` zips the whole R2 prefix (`servicer.py:901-942`) — so stored `pages/<path>` objects would appear in exported zips with zero export changes. The viewer is an RSC that maps **any** `getPage` failure to `notFound()` (`[pageId]/page.tsx:12-15`); per-subpage titles are extractable from linked-page merged HTML (merge runs unconditionally), and `page_filename_map`/`page_url` survive to assembly time.

## Goals / Non-Goals

**Goals:**

1. Linked-page asset fetching obeys the same option snapshot as the main page (agreed policy: assets only when HTML output is on, or images/documents-only; never for text/markdown-only runs).
2. Pause waits indefinitely for Resume/Stop; worker death while paused parks the download (checkpoint + queue snapshot) with a Paused card offering Resume/Stop.
3. No false "service was restarted" and no false "Done!": both declarations require liveness or terminal-server evidence.
4. Per-page text: streamed per page, stored per page, ordered main-first; no whole-run text accumulator.
5. Multi-page text/markdown artifacts keep one file per page under `pages/` with readable slugs, locally and in the cloud; PagePocket zip gains `pages/`.
6. PagePocket viewer navigates multi-document pages via a burger-menu sidebar; transient viewer failures are retryable.
7. Per-page progress visible as a counter; honest merge-phase wording in text-only runs.

**Non-Goals:**

- No true pause of the **main-page scroll phase** (panel-driven and short; pause scope remains the linked-page phase).
- No re-scrape-on-resume redesign of the existing interrupted-download resume path (finalize-and-poll stays as-is for _interrupted_ downloads; parked _paused_ downloads get scrape-resume).
- No server-side parked-session TTL changes or exemption from the 20-active-sessions cap (documented limitation; see Risks).
- No REST ingest changes (`POST /pages/ingest` keeps `html_content`/`markdown_content`/`text_content`); pages travel only via the monolith's gRPC push.
- No offline images in markdown (markdown keeps absolute source-site image URLs — v1 stance from download-as-markdown).
- No retroactive upgrade of existing PagePocket pages (pages/ support is forward-looking at ingest).

## Decisions

### D1 — Asset gating: pass the press-time snapshot into the scraper, gate per category

Thread the normalized `downloadOptions` into `LinkedPageScraper` and gate `downloadAssets()` per category exactly like `download-core.ts:824-855` does: images on `downloadImages`, css/js on `downloadAssets`, documents on `downloadDocuments`.

_Why this shape:_ the policy ("assets only when HTML on or images-only") already falls out of `validateFilterOptions` — HTML-on force-enables images+assets (`filterStore.ts:81-84`), HTML-off force-disables assets (`:89-92`), text-only normalization zeroes images/assets/documents (`filterTypes.ts:56-86`). The linked scraper never received that snapshot. Gating per category (rather than one blunt "no assets" switch) preserves images-only and documents-only modes, which remain legal configurations.

_Alternative rejected:_ re-reading live options mid-run — rejected twice over: the session itself is a create-time snapshot (server options blob), so mixed live/frozen semantics would be incoherent; and mid-run option flips changing scrape behavior is what confused the operator in the first place.

### D2 — True pause via a three-state machine: SCRAPING → PAUSED → PARKED

```
                 pause                    resume (worker alive)
  SCRAPING ───────────────► PAUSED ◄───────────────────── SCRAPING
                  │             │
   (60s watchdog  │  worker dies▼  (panel closed / memory pressure / restart)
    REMOVED)      │             │
                  ▼          PARKED  (checkpoint phase="paused" + queue snapshot)
                                │
              panel reopens ────┼─ Resume ► re-spawn scraper from snapshot ─► SCRAPING
                                └─ Stop   ► finalize partial ─► deliver artifact
```

- **Remove** `PAUSED_WATCHDOG_MS` and the keepalive-disconnect auto-stop-while-paused. Pause blocks between-page advancement indefinitely (same check sites `:422-427,:522-527`).
- **Release the tab on pause**: run `restoreOriginalPage()` immediately when pausing (not only at loop exit), so the browser tab isn't held hostage. Resume re-acquires a tab (recreate in background if the original is gone) and continues from the snapshot.
- **Park**: on pause, write checkpoint phase `paused` plus a **queue snapshot** to `chrome.storage.session`: remaining internal/external queues (URLs, capped at 5,000 entries — beyond that, pause records a "snapshot truncated; stop finalizes partial" marker), visited/processed URL set, current phase, and counters. On worker wake with a `paused` checkpoint, the panel shows the **Paused card** (Resume/Stop) — never the interrupted card.
- **Resume-from-park** re-spawns `LinkedPageScraper` seeded from the snapshot (same server session — it was never finalized), re-attaches the keepalive port, and continues. Asset dedup after a park uses the server's `url_hash` dedup (`resources.py:261,466-470`) since the in-memory `AssetRegistry` is lost — occasional duplicate _fetches_ are avoided server-side at storage.

_Why park instead of "prevent SW death":_ MV3 makes indefinite worker lifetime unachievable (panel closed, memory pressure, browser restart). The parked state converts an unavoidable death from "download silently gone / false interrupted card" into a resumable state. _Alternative rejected:_ pause-as-stop + existing resume — already rejected by product decision (operator wants scrape continuation, not finalize-on-pause).

### D3 — Liveness-proof declarations (interrupted AND complete)

- **Persisted liveness**: replace the in-memory `liveServerSessionIds` Set with a `chrome.storage.session` liveness record (session id + heartbeat timestamp, written at `markSessionLive` and refreshed by the existing 15 s upload heartbeat and a new poll-ack). The panel poll treats "no liveness record" as _unknown_, not _dead_: it may declare completion only when (a) the terminal server status confirms `ready`/`failed`/`cancelled` **or** (b) a live heartbeat is recent and the flow pushed a terminal message. The false-positive path (`livePolling.ts:66-67` on a lost Set) is closed.
- **Interrupted card requires proof**: the 45 s silence watchdog and the startup checkpoint push (`cleanupHandlers.ts:258-318`) must first probe liveness — ping the worker (`CHECK_DOWNLOAD_LIVE` already exists) and check the liveness record's freshness — before declaring "service was restarted". Silence alone during a long merge is no longer sufficient.
- **Merge-phase heartbeat**: the assembly poll already receives `assemblyProgress` phase pushes; add a lightweight periodic push (or reuse poll ticks) so long merges (`zip_assembler.py:230-239`) do not look like silence. This is also what makes D3's watchdog safe to keep for genuinely dead workers.
- **`paused` checkpoints are invisible to interrupted detection**: both the startup push and the watchdog skip checkpoints with phase `paused` (they route to D2's Paused card instead).

_Alternative rejected:_ removing the watchdog entirely — a genuinely dead worker must still surface as interrupted, else downloads die silently; the fix is proof, not removal.

### D4 — Per-page text: stream per page, store per page, key by page URL

- **New endpoint** `POST /api/v1/sessions/{session_id}/content/pages` with body `{ page_url: str | null, text: str }` (`null`/absent = main page). Server stores `content_pages/<page_url_hash>.txt` (same `sha256[:16]` scheme as html chunks, `html.py:146-150`), **replace-on-rewrite** semantics (idempotent resume/retry — mirrors html-chunk dedup-by-identity rather than append). The legacy append endpoint stays for backward compatibility (older extensions).
- **Extension upload order fixed**: main text uploaded **first** (right after main-page extraction), each subpage's text immediately after its scrape (`linked-page-scraper.ts` per-page hook, gated on `extractText` as today at `download-core.ts:989`). `accumulatedText` and its end-of-run single append are deleted. Reading order in artifacts becomes main-first, subpages in scrape order — fixing the current inversion (`download-core.ts:1020-1041` and its contradictory comments).
- **Memory**: the whole-run text hold disappears; per-page text lives only for the duration of one upload (5 MB cap per request inherited from the existing content route, `config.py:97`).

_Alternative rejected:_ streaming appends into the single `content.txt` — preserves the blob, makes resume-after-park double-append-prone, and keeps the wrong file model that D5/D6 must undo anyway.

### D5 — Readable slugs for text pages: reuse the existing generator

Add `text_zip_path_for(path)` beside `markdown_zip_path_for` (`zip_assembler.py:2400-2409`) — same pure extension swap. Per-page text files get `pages/<slug>.txt` from `generate_page_filename(page_url)` with the existing collision scheme (`about.txt`, then `about-c3d4.txt`); pages without a captured URL fall back to `<page_url_hash>.txt` exactly like html (`zip_assembler.py:947`). Naming consistency across `pages/<name>.html|.md|.txt` is invariant: same slug base, same collisions.

### D6 — Local zip layout for text-only multi-page runs

`_assemble_text_only` (`zip_assembler.py:1134-1232`) gains the per-page documents: `index.txt` (main) + `pages/<slug>.txt` per linked page (+ `pages/<slug>.md` when markdown is also on, already implemented). The "one file → raw download, many files → zip" delivery rule is preserved: a **single-page** text run still delivers raw `content.txt` (renaming unchanged); a **multi-page** text run now produces multiple files → zip — which is precisely the operator expectation and the text-native D3 intent the current implementation missed.

### D7 — Cloud push: per-page content documents + manifest

- **Proto (additive)**: `message PageDocument { string path = 1; string title = 2; string url = 3; string content_format = 4; bytes data = 5; }` and `repeated PageDocument pages = N` on `IngestPageRequest`; `repeated PageSummary pages` (`path/title/url/content_format`) on `PageResponse`. Proto3 additive evolution — unknown fields are ignored by older readers; regenerate stubs via `make proto` only.
- **Storage**: archive-service writes each `PageDocument` at `{prefix}/pages/<path>` (asset-path handling already preserves slashes, `servicer.py:403,456`) and records the manifest in `meta.json` as `"pages": [{path, title, url, content_format}]`. Quota `size_bytes` includes pages data. `ExportPage` needs **no changes** — the prefix listing picks pages up automatically (`servicer.py:901-942`), fulfilling the operator's "zip contains pages/ dir".
- **Monolith push** (`zip_assembler.py:558,:1524-1526`): when `download_html` is false, linked-page markdown (`page_md_list`, already computed at `:382-388`) and the new per-page texts are pushed as `PageDocument`s instead of being dropped; titles for the manifest are extracted from linked-page merged HTML `<title>` (merge runs unconditionally — `:230-239,:1927-1934` — so titles exist in every mode), falling back to the slug base name. `CLOUD_MAX_ASSETS` counting is unaffected (pages are documents, not assets).
- **Retrieval**: `GetPage` returns the pages summary list; gateway `GET /archive/pages/{page_id}` passes it through; the viewer schema gains a tolerant optional `pages` field (absent = legacy page, no sidebar).

### D8 — Viewer: burger-menu subpage navigation + retryable failures

- `page-viewer-shell.tsx` renders a burger button when `pages.length > 1` (markdown/txt/html alike), opening a sidebar listing subpages (title + host/path), active item highlighted; selecting one swaps the main pane's document by fetching `/f/pages/<path>` (same no-store fetch pattern as format tabs), updates `?page=` + existing `?format=` params via `router.replace(..., { scroll: false })`. Back/forward works like format switching does today. `public-viewer-shell` parity per existing conventions.
- **Failure hardening**: distinguish 404 (page truly absent → `notFound()`) from transient failures (network/gateway/5xx → retryable error state with a Retry button). The RSC currently maps _everything_ to `notFound()` (`[pageId]/page.tsx:12-15`) — the operator's "didn't load until reload" case becomes a visible retry instead of a dead end.

### D9 — UI surfacing: counter, paused card, honest merge wording

- **Page counter as first-class state**: `status.linkedPageProgress` (`current/total`, already pushed per page — `linked-page-scraper.ts:431-439,:531-539`) gains a dedicated state field (not just a messages-feed line) rendered as a prominent "Page X of Y" counter on the scraping card (`DownloadStatus.tsx`) and reflected in the headline region while scraping.
- **Paused card**: new server-mode phase `paused` rendering Resume + Stop; park-aware (`download-ux-feedback`).
- **Merge wording**: when the session options have `downloadHtml=false`, the assembly subtitle for `merging_html` reads "Preparing text conversion (merging captured HTML)" — same phase machinery (`DownloadStatus.tsx:511-517`, `en.json:226`), honest copy explaining why a text run still merges. Stop-then-finalize keeps triggering merge (by design; salvage needs the session finalized).

## Risks / Trade-offs

- [Snapshot truncation for huge scrapes: >5,000 queued URLs can't fully persist in the pause snapshot] → Cap + explicit marker; a Stop on a truncated park still finalizes the partial; Resume continues with the truncated queue and a note. Full-site queue limits (`maxPages`) keep realistic runs well under the cap.
- [Parked sessions count toward the 20-active-sessions cap and may expire server-side] → Documented in proposal; Resume reuses the existing expired-session fallback (offers Restart); Paused card's Stop always works. A future change may add parked-aware TTL.
- [Duplicate asset *fetches* after park-resume (in-memory `AssetRegistry` lost)] → Server-side `url_hash` dedup prevents duplicate _storage_; extension-side re-fetch cost is bounded by the visited-set persisted in the snapshot (pages are not re-scraped, so their assets are not re-discovered).
- [Resume-from-park correctness risks (tab gone, server session state drift)] → Tab is recreated, never assumed; the server session was never finalized during pause; all uploads are idempotent-or-replace keyed by identity (html chunks by hash+index, pages by page_url_hash).
- [Persisted-liveness heartbeat could delay legitimate completion detection] → Heartbeat age is bounded; terminal server status (`ready`/`failed`/`cancelled`) always overrides — the guard only blocks declaring completion from _absence of evidence_, never delays evidence-based completion.
- [Proto evolution friction] → Strictly additive fields, regenerated stubs via the repo's proto tooling; older archive-services ignore unknown proto3 fields; no REST contract change.
- [45-locale i18n surface for new strings (counter, paused card, merge wording, retry state)] → Reuse `scripts/sync-locales.mjs`; English fallback pattern already enforced by locale-coverage tests.
- [One change spans four deployables (extension, monolith, archive-service+gateway, frontend)] → Tasks ordered so each workstream is independently green; deploy order: proto/archive-service/gateway → monolith → extension → frontend; all changes additive so partial deploys degrade gracefully (empty pages lists, legacy content endpoint still honored).

## Migration Plan

1. Land server-side first: per-page content endpoint + zip layout + cloud push + proto/archive/gateway (monolith and PagePocket deploy per runbook; backend deploys via CI, monolith manual §3 on explicit order). No data migration; existing sessions assemble unchanged (per-page docs absent → legacy layouts still produced).
2. Land extension second: gating, pause/park, liveness proofs, streaming, UI. Older-extension compatibility: new content endpoint is additive; legacy append endpoint untouched.
3. Frontend viewer last (depends on archive-service pages support). Legacy pages (no `pages` field) render exactly as today.
4. Rollback: revert by service; additive contracts mean any single revert is safe. The one destructive-ish edit — deleting the `accumulatedText` path — is recovered by reverting the extension alone.

## Open Questions

- Should a parked download auto-finalize after N days of continuous pause (server TTL interplay), or wait indefinitely for the user? (Design leans: wait indefinitely; expiry surfaces via the existing Resume fallback.)
- Should the REST ingest path ever accept `pages/` (for parity if a non-monolith client wants multi-doc ingest)? (Leans: no until a second gRPC/REST client exists.)
- Page counter placement: inside the scraping card only, or also as the headline suffix ("Downloading — page 3 of 12")? (Leans: both; finalize wording during implementation.)
