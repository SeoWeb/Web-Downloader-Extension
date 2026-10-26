## Context

Server-mode is the only pipeline: the extension uploads raw HTML chunks + a filename map, and the server does ALL rewriting. `_convert_links` (`server/app/services/html_converter.py:851-947`) currently rewrites same-origin anchors to local `pages/` files but skips external origins (`:887-894`). The map it consults, `page_filename_map`, is built in `zip_assembler.py:229-250` from ALL linked merge results — internal and external alike — keyed by `page_url_hash` = `sha256(pageUrl)[:16]`. So the data needed to link downloaded external pages is already present; the rewriter just never looks.

On the extension side the config has grown a redundant layer: "Download links" (Filter.tsx:327-334) gates a nested group containing the "Full Scraping" checkbox and its options (Filter.tsx:336-434), a derived "Full Website" preset sits beside them (Filter.tsx:207-212), and simple mode shows a red warning (Filter.tsx:124-136). In the background, the scraping branch is gated on the nested pair (`download-core.ts:751-752`), with a legacy "simple fetch" path (`fetchAndUploadLinkedPages`) still alive beside it. The store validator lives at `src/stores/filterStore.ts:40-87`.

## Goals / Non-Goals

**Goals:**

- One concept, one control: "Full Scraping" is the single first-level checkbox; its options nest beneath it.
- "Download Full Website" preset behaves as an honest derived summary of HTML + assets + fullScraping.
- Saved external pages become reachable by clicking links in the downloaded HTML (local archive coherence).
- No user loses stored preferences; no data migration.

**Non-Goals:**

- Migration for legacy simple-mode prefs (`downloadLinks:true` without fullScraping) — they become inert, silently.
- Changes to `page_url_hash`, filename mapping, or the cloud-push payload (it receives post-rewrite HTML and inherits the fix).
- New scraping features or quota/limit changes.

## Decisions

- **D1 — `downloadLinks` key retained for storage compatibility.** The key stays in `filterTypes`, `DEFAULT_FILTER_OPTIONS`, and storage validation: the storage error handler requires all 7 boolean keys, and dropping one would make validation discard users' entire stored filter prefs. The UI simply never sets it true; text-only normalization is unchanged (still forces outgoing `downloadLinks:false`).
- **D2 — Gate on fullScraping.** The linked-pages scraping branch in `download-core.ts` checks `downloadLinksFullScraping` directly (no `downloadLinks` conjunct). The legacy "simple fetch" branch (`fetchAndUploadLinkedPages`) and its test file are deleted — dead code once the gate no longer reaches it.
- **D3 — Legacy simple-mode prefs are inert, no migration.** Stored prefs with `downloadLinks:true` but fullScraping off simply stop triggering linked-page scraping. Product decision: drop silently; the new UI never produces that combination.
- **D4 — External rewrite only when the page was actually downloaded.** `_convert_links` looks external-origin anchors up in `page_filename_map` (which already spans internal + external downloaded pages); found → rewrite to `{path}pages/<name>.html` (`./` prefix from the main page, `../` from within linked pages); not found → keep the absolute URL (today's behavior). No eager fetching, no new downloads — linking is strictly a function of what was already saved.
- **D5 — singleFile forces fullScraping off.** The store validator and the singleFile handler now force `downloadLinksFullScraping:false` (previously only `downloadLinks:false` was forced — latent bug, since single-file output cannot contain linked pages).

## Risks / Trade-offs

- [Users relied on legacy simple-mode ("download links without full scraping")] → accepted loss: that mode produced stub pages and duplicated the fullScraping path; silent inertness is the documented behavior (D3).
- [External anchor rewrite surprises] → bounded by D4: only anchors whose target page is present in the archive are rewritten; everything else keeps its absolute URL, so offline browsing degrades exactly as today.
- [Relative-path mistakes between main page and linked pages] → pinned by unit tests: `./pages/<name>.html` from the main page, `../pages/<name>.html` from a linked page.
- [Monolith not yet rebuilt while new extension ships] → harmless in both orders: the gate swap is extension-local; the converter change only rewrites anchors when the map contains the target, which old builds ignore safely.

## Migration Plan

1. Land extension + monolith changes in one commit on the working branch.
2. User rebuilds/reloads the extension locally; verify the new options UI and a full-website download whose external linked pages open via local links.
3. Monolith rebuild happens on the user's explicit order (runbook §3 3b) — until then external links in fresh archives stay absolute (current behavior).
4. Rollback: revert commit; no schema, storage, or wire changes to roll back.

## Open Questions

- None blocking.
