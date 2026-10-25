## 1. PagePocket backend — proto + archive-service

- [x] 1.1 `pagepocket/proto/archive.proto`: additive `ContentDocument {content_format, data}` + `repeated ContentDocument content_documents` on `IngestPageRequest`; `repeated string content_formats` on ingest + page-read responses; regenerate stubs via `make proto` (never hand-edit)
- [x] 1.2 `archive-service/servicer.py` ingest: store `index.md`/`index.txt` with correct content types, `meta.json` gains `content_formats` (html first), sanitize/asset-rewrite HTML only, `size_bytes` includes all docs, search/preview text from HTML else text doc, reject zero-document ingests; page detail returns `content_formats`
- [x] 1.3 Tests: multi-format round-trip; text-only ingest + search/preview; empty-content rejection; legacy (html-only) ingest unchanged; read-path formats reported

## 2. PagePocket backend — gateway

- [x] 2.1 `POST /pages/ingest`: optional `markdown_content`/`text_content` file parts → `content_documents`; response carries `content_formats`; `GET /pages/{id}` + file-serving route: `content_formats` in detail, correct content types + same CSP for `.md`/`.txt`
- [x] 2.2 Tests: multi-part ingest; legacy single-part unchanged; detail formats; text file serving headers
- [x] 2.3 Share validate enriches response with `content_formats` via archive page-read (graceful `[]` on archive failure) — share-viewer parity

## 3. Monolith — output rules

- [x] 3.1 Session-create options: parse/store `downloadHtml`, `downloadContentAsText` (alongside `singleFile`, `downloadContentAsMarkdown`)
- [x] 3.2 `zip_assembler.py`: text-only assembly (no `index.html`, no HTML-only extras when HTML off); raw delivery of exactly-one-file artifacts (`.md`/`.txt` with filename + MIME; `.html` singleFile behavior preserved); multi-file → zip
- [x] 3.3 Tests: markdown-only single page → raw `.md`; content-only → raw `.txt`; multi-page markdown → zip without `index.html`; html+md → bundle with both; singleFile unchanged

## 4. Monolith — cloud push

- [x] 4.1 Cloud-push branch: generate markdown (shared converter) when enabled, include uploaded text when enabled, push via REST parts `markdown_content`/`text_content`; HTML off → text-only push (empty `html_content`)
- [x] 4.2 Tests: html+md push payload; text-only push payload; legacy (no text flags) payload unchanged

## 5. PagePocket frontend — viewer

- [x] 5.1 Schema/client: `content_formats` on page detail (tolerant zod parse); type updates
- [x] 5.2 `page-viewer-shell.tsx`: format switcher (>1 format; HTML default), markdown tab (react-markdown, raw-HTML escaped — pinned test) + raw toggle, text tab, legacy single-format pages unchanged
- [x] 5.3 `public-viewer-shell.tsx`: same switcher/defaults
- [x] 5.4 Tests: switcher render per format set; script-tag markdown inert; raw toggle content; legacy page no switcher; share parity
- [x] 5.5 Active format survives back/forward: `?format=` URL param (validated against known formats) is the initial tab; switching tabs updates it via `router.replace(..., { scroll: false })`; invalid param → HTML default; share viewer parity
- [x] 5.6 Viewer back button deterministic: in-app navigation trail in sessionStorage replaces `document.referrer` (self-reload no-op, deep-link, collections all covered); Escape unchanged

## 6. Extension

- [x] 6.1 Session options: send `downloadHtml` + `downloadContentAsText` in `POST /sessions` body
- [x] 6.2 `Filter.tsx`: disable images/assets/documents/singleFile with hint when only text formats selected
- [x] 6.3 vitest + tsc green

## 7. Verify & ship

- [x] 7.1 All suites green: pagepocket backend (`make test`), frontend (vitest+build), monolith (`server/` pytest), extension (vitest+tsc)
- [x] 7.2 Commit + push `main:pagepocket`; CI green; `deploy-backend` + `deploy-frontend` succeed
- [x] 7.3 Monolith rebuild on user's explicit order (runbook §3)
- [ ] 7.4 User verification: text-only local download is a raw `.md`/`.txt`; cloud text page + switcher at pagepocket.app; html+md toggle page; old pages unchanged; dashboard cards/thumbnails fall back gracefully for text pages
