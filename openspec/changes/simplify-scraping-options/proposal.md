## Why

The scraping config is confusing: a "Download links" checkbox gates nested options, with a separate "Full Scraping" checkbox and a derived "Full Website" preset sitting beside it — three controls expressing one concept. Additionally, downloaded external pages aren't linked from the saved HTML: the monolith's link rewriter skips external-origin anchors entirely, so a user who paid for their download lands on dead absolute links when browsing the archive offline.

## What Changes

- **Extension UI (`src/components/Filter.tsx`)**: the "Download links" checkbox, its handler, and the red simple-mode warning are removed. "Full Scraping" becomes the first-level checkbox; its three options (max pages slider, delay between pages slider, include external links checkbox) render beneath it when it is on — same blue group box design, outer wrapper `mt-2 space-y-3` (the left indent `ml-7` is dropped since the group is now first level).
- **"Download Full Website" preset**: derived checked state = `downloadHtml && downloadAssets && downloadLinksFullScraping`. Turning it ON sets singleFile off + HTML/assets/fullScraping on; turning it OFF sets fullScraping off. One click = "grab everything".
- **singleFile fix**: `singleFile` now forces `downloadLinksFullScraping:false` (store validator + handler) — previously it only forced `downloadLinks:false`, leaving fullScraping on (a latent bug; single-file output can't contain linked pages).
- **Background gating (`src/background/download-core.ts`)**: the linked-pages scraping branch is gated on `downloadLinksFullScraping` directly (was nested under `downloadLinks`); the legacy "simple fetch" branch (`fetchAndUploadLinkedPages`) and its test file are deleted. Legacy stored prefs with `downloadLinks:true` without fullScraping become inert (product decision: drop silently — no migration).
- **Storage compatibility**: the `downloadLinks` option key is KEPT in `filterTypes`/`DEFAULT_FILTER_OPTIONS`/storage validation (the storage error handler requires the 7 boolean keys — removing it would discard users' stored prefs); the UI simply never sets it true. Text-only normalization is unchanged (still forces outgoing `downloadLinks:false`).
- **Monolith link rewriting (`server/app/services/html_converter.py`, `_convert_links`)**: external-origin anchors are looked up in `page_filename_map` (already built from ALL downloaded linked pages, internal + external); found → rewritten to `{path}pages/<name>.html` (path `./` from the main page, `../` from linked pages); not found → stays absolute (current behavior). Cloud push inherits automatically (it receives post-rewrite HTML).
- **i18n**: `filter.downloadLinks` and `filter.linksWarning` keys removed from all 45 locales.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `user-interface`: scraping options restructured — single first-level "Full Scraping" checkbox with its nested group, "Download Full Website" derived preset, singleFile forcing fullScraping off.
- `linked-pages`: linked-pages scraping gated on `downloadLinksFullScraping` only; legacy simple-fetch branch removed.
- `extension-server-client`: `downloadLinks` retained in stored/session options for compatibility but no longer set by the UI.
- `server-html-converter`: downloaded external linked pages are rewritten to local `pages/` links in the saved HTML.
- `localization`: `filter.downloadLinks` / `filter.linksWarning` removed from all locales.

## Impact

- **Extension**: `src/components/Filter.tsx` (checkbox removal, first-level group, preset), `src/stores/filterStore.ts` (validator + singleFile handler), `src/background/download-core.ts` (gate swap, dead branch deletion), i18n locale files; vitest/tsc.
- **Monolith (`server/`)**: `html_converter.py` `_convert_links` external-anchor handling; pytest. No proto/API/storage changes — `page_filename_map` already contains every downloaded linked page.
- **Deploy**: extension rebuilt/reloaded by the user; monolith rebuilds only on the user's explicit order (runbook §3 3b). Safe in both orders — the converter change is independent and the old UI works against the new gate.
- **Out of scope**: migrating legacy `downloadLinks:true` prefs, new scraping capabilities, changes to `page_url_hash`/filename mapping, cloud-push payload changes.
