## 1. Server — converter service

- [x] 1.1 Add `markdownify>=0.13,<1.0` to `server/requirements.txt` (HTML parsing section, after bs4/lxml)
- [x] 1.2 Create `server/app/services/markdown_converter.py` with `convert_html_to_markdown(html: str, base_url: str) -> str`: strip `script, style, noscript, template, svg`; resolve relative `href`/`src` against `base_url` via `urljoin`; convert with markdownify; normalize whitespace; return `""` for empty input
- [x] 1.3 Create `server/tests/test_markdown_converter.py`: headings/links/images/code/tables/lists; no script/style leakage; relative→absolute URL resolution; empty-body input

## 2. Server — option + assembly integration

- [x] 2.1 Add `downloadContentAsMarkdown: bool = False` to `SessionOptions` (`server/app/api/routes/sessions.py:82-95`) so it persists in the session options blob (same path as `singleFile`)
- [x] 2.2 In `zip_assembler.assemble_session` (~`:126`, post-merge, pre-Phase-2): when `session.options.get("downloadContentAsMarkdown")`, convert the main merged HTML via `asyncio.to_thread` with the session's original URL as base; per-document try/except → log + omit on failure (never fail assembly)
- [x] 2.3 Thread the main-page markdown into `_assemble_zip` and write `content.md` in the ZIP root (mirroring the `content.txt` write at `:522-529`); absent when option off
- [x] 2.4 In the linked-pages ZIP loop: convert each `linked_page_htmls` entry with its stored original page URL as base and write `pages/<hash>.md` beside `pages/<hash>.html` (same hash mapping), each file starting with `<!-- source: <original-url> -->` + title H1 when available; per-page failure isolation
- [x] 2.5 Confirm single-file and cloud branches ignore the option (no markdown embed; add code comment documenting the v1 deferral)
- [x] 2.6 Server tests: extend `server/tests/test_zip_assembler.py` — md present/absent by option; original-URL links in `content.md`; per-page `pages/<hash>.md` + source stamps; both text options on → both files; single-file unchanged; converter failure → assembly succeeds minus the md file

## 3. Extension — option plumbing + UI

- [x] 3.1 `src/types/filterTypes.ts`: add `downloadContentAsMarkdown?: boolean` to `FilterOptions` + `DEFAULT_FILTER_OPTIONS` (`false`)
- [x] 3.2 `src/stores/filterStore.ts`: wire the four rule sites — `validateFilterOptions` (forced off under `singleFile`; no coupling to `downloadContentAsText`), `hasContent`, `hasAnyContentSelected` (counts as content alone), `isValidConfiguration`
- [x] 3.3 `src/hooks/useFilterOptions.ts`: setter + `useDownloadOptions` passthrough
- [x] 3.4 `src/components/Filter.tsx`: new `OptionItem` checkbox "Download content as Markdown" next to the text option; disabled/cleared under single-file; reset branches updated
- [x] 3.5 `src/background/server-client.ts`: add the flag to the `SessionOptions` interface (`:180-184`) + `createSession` body (`:426-431`)
- [x] 3.6 `src/background/download-core.ts`: pass the flag through `createSessionWithCloudRetry` options (`:401-405`)
- [x] 3.7 i18n: add `filter.downloadContentAsMarkdown` (+ aria label) to `src/i18n/locales/en.json`; run `node scripts/sync-locales.mjs`; locale-coverage test green
- [x] 3.8 Extension tests: filterStore validation matrix (alone / with text option / under singleFile); createSession body carries the flag; UI checkbox renders translated label

## 4. Verify & ship

- [x] 4.1 Extension: vitest + typecheck + lint green; `npm run build` succeeds; secret-scan staged diff
- [x] 4.2 Server: monolith pytest green (CI `server` job)
- [x] 4.3 Commit + push `main:pagepocket`; confirm CI green; confirm deploy workflow skipped both frontend and backend (extension + server changes deploy nothing automatically)
- [x] 4.4 Manual monolith deploy on host (operator-approved window): `git fetch` + `git reset --hard origin/pagepocket`, `docker compose -f docker-compose.yml build app`, `up -d`, verify health `200`, unauthenticated `cloud/link` → 401
- [ ] 4.5 E2E verification (operator, rebuilt extension): content-only download → `content.md` with clean markdown + original URLs; linked-pages download → one `pages/<hash>.md` per page with source stamps; both-text-options run → `content.md` + `content.txt` coexist; single-file run unchanged; tick tasks + archive
