## 1. Extension UI

- [x] 1.1 `src/components/Filter.tsx`: remove the "Download links" checkbox (Filter.tsx:327-334), its handler, and the red simple-mode warning (Filter.tsx:124-136)
- [x] 1.2 `src/components/Filter.tsx`: promote "Full Scraping" to first level — the three options (max pages slider, delay between pages slider, include external links checkbox) render beneath it when on; same blue group box, outer wrapper `mt-2 space-y-3`, drop the `ml-7` indent (Filter.tsx:336-434)
- [x] 1.3 `src/components/Filter.tsx`: "Download Full Website" preset derived state = `downloadHtml && downloadAssets && downloadLinksFullScraping`; ON → singleFile off + HTML/assets/fullScraping on; OFF → fullScraping off (Filter.tsx:207-212)
- [x] 1.4 `src/stores/filterStore.ts`: validator + singleFile handler force `downloadLinksFullScraping:false` (previously only `downloadLinks:false`); `downloadLinks` key retained in `filterTypes`/`DEFAULT_FILTER_OPTIONS`/storage validation (all 7 boolean keys required), UI never sets it true
- [x] 1.5 i18n: remove `filter.downloadLinks` and `filter.linksWarning` from all 45 locales
- [x] 1.6 Tests: fullWebsite preset derivation (on/off/singleFile interplay), singleFile forces fullScraping off, group renders only when fullScraping on, removed checkbox/warning no longer present

## 2. Extension background

- [x] 2.1 `src/background/download-core.ts`: gate the linked-pages scraping branch on `downloadLinksFullScraping` directly (was nested under `downloadLinks` at download-core.ts:751-752)
- [x] 2.2 `src/background/download-core.ts`: delete the legacy "simple fetch" branch `fetchAndUploadLinkedPages` and its test file
- [x] 2.3 Tests: scraping runs with fullScraping on (downloadLinks false/absent), does not run with fullScraping off; legacy `downloadLinks:true`-only prefs inert

## 3. Monolith

- [x] 3.1 `server/app/services/html_converter.py` `_convert_links`: external-origin anchors looked up in `page_filename_map`; found → rewrite to `{path}pages/<name>.html` (`./` from main page, `../` from linked pages); not found → keep absolute URL
- [x] 3.2 Unit tests: external anchor with map hit rewritten (`./` from main, `../` from linked page); map miss stays absolute; internal-anchor behavior unchanged
- [x] 3.3 Zip-level test: end-to-end assembly with downloaded external linked page — saved HTML links resolve to `pages/<name>.html` inside the archive

## 4. Verify & ship

- [x] 4.1 Extension: vitest + tsc green
- [x] 4.2 Monolith: `server/` pytest green
- [ ] 4.3 User verification: rebuild + reload extension — options UI shows single first-level Full Scraping group, Full Website preset toggles correctly, full-website download's external links open locally
- [ ] 4.4 Monolith prod deploy on the user's explicit order (runbook §3 3b); re-verify external link rewrite on a fresh archive
