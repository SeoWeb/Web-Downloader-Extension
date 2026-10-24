## Context

Every download is server-mode: the extension always streams raw HTML chunks + resources to the conversion server (`download-core.ts:334,401-409,624-631`), which assembles the artifact. Markdown is generated server-side from that HTML (`markdown_converter.py`, markdownify) and — like `content.txt` (extension-extracted, uploaded via `/content`) — is only ever an extra file inside the HTML zip. `singleFile` is the sole output shape that skips the zip (`zip_assembler.py:458-467`). The cloud-push branch ignores the markdown flag (`:369-372`), and PagePocket's ingest is HTML-only: `IngestPageRequest{html_content, assets}` (`archive.proto:37-47`), always stored as `index.html` (`servicer.py:379-380`), viewer renders that file in a sandboxed iframe (`page-viewer-shell.tsx:188-193`).

Key facts that shape the design:

- The extension never converts anything itself (D5/D7 of download-as-markdown) — HTML reaching the server is what makes markdown generation possible. "No HTML" must therefore mean _never delivered to the user / never stored as the page_, not _never scraped_.
- Session-create options carry only `{singleFile, downloadContentAsMarkdown, retentionDays, pagepocketUserId}` (`server-client.ts:429-454`) — `downloadHtml` and `downloadContentAsText` never reach the server today, so the assembler cannot currently honor "HTML off".
- `Page` model has no format column; formats are derivable from what's stored in R2 + `meta.json`.
- Pagepocket frontend deploys atomically with its backend (same commit, CI jobs); the monolith deploys manually on the user's order.

User decisions (plan session 2026-10-24): markdown/content-only → no HTML anywhere in output; single output file → raw download (no zip); PagePocket + text modes → text pages in the cloud ("Text-only pages"); markdown renders **with a raw toggle**; HTML+text together → **HTML page is default but viewer toggles to the other stored formats**; images/assets/documents/single-file toggles **ignored in text-only modes**.

## Goals / Non-Goals

**Goals:**

- A markdown-only or text-only download really produces only that file — locally and in the cloud.
- One file → raw download; many files → zip (uniform rule, extending the existing singleFile branch).
- Cloud pages store every generated format; the viewer lets the user switch, defaulting to HTML.
- Fully additive backend: old pages, old pushers, and old viewers keep working unchanged.

**Non-Goals:**

- EPUB/other formats; on-demand re-rendering of HTML pages as markdown; per-format storage quotas.
- Changing the scrape pipeline (HTML is still always scraped — it is the conversion input).
- Changes to already-stored HTML pages (no backfill).
- Viewer for text pages inside the extension (local files open in the browser/editor as usual).

## Decisions

- **D1 — Contracts pinned up front** (single source of truth for all four workstreams):
  - Formats enum: `"html" | "markdown" | "text"`.
  - Proto: `IngestPageRequest` += `repeated ContentDocument content_documents` where `ContentDocument { string content_format = 1; bytes data = 2; }`; `html_content` becomes optional (empty ⇒ text-only page). `IngestPageResponse` and the page-read RPC responses gain `repeated string content_formats`. Additive field numbers only.
  - REST ingest (`POST /pages/ingest`): optional file parts `markdown_content`, `text_content` alongside existing `html_content`.
  - R2 layout: `index.md` (content type `text/markdown; charset=utf-8`), `index.txt` (`text/plain; charset=utf-8`) next to `index.html`; `meta.json` gains `"content_formats": [...]` (html first when present).
  - Page detail (`GET /pages/{id}` + underlying RPC): response += `content_formats: string[]`.
  - Session-create options (extension → monolith): += `downloadHtml: bool`, `downloadContentAsText: bool` (camelCase like existing `singleFile`/`downloadContentAsMarkdown`).
- **D2 — HTML is always scraped; "no HTML" is an output rule.** The monolith always receives the scraped HTML (markdown/text derive from it). In text-only modes the assembled artifact and the cloud push simply exclude it; nothing upstream changes.
- **D3 — Output-shape rule (monolith).** Collect the artifact's top-level files under the active options. Zero files → existing empty/edge behavior unchanged. Exactly one file → deliver raw (`chrome.downloads` filename derives the extension; `output_type` generalized to carry filename + mime for `.md`/`.txt`, keeping `html` for singleFile and `zip` for bundles). More than one → zip as today. Linked-page text modes produce per-page text files, so they naturally land in the zip branch.
- **D4 — Multi-format cloud pages.** Primary content = `index.html` when present, else the single text document. Ingest stores every `content_documents` entry as its `index.<ext>`, records `content_formats` in `meta.json`, skips HTML sanitization/asset-rewrite for text entries, and counts all stored bytes in `size_bytes`. Search/preview text: HTML extraction when HTML exists, else the text document itself.
- **D5 — Cloud push mirrors local selection.** The cloud-push branch stops ignoring the text flags: it generates markdown (same converter as the zip path) and/or reuses the uploaded text, and pushes `html_content` (if HTML on) plus the matching REST parts. HTML off ⇒ push contains only the text document(s).
- **D6 — Viewer format switcher.** Page viewer + public share viewer read `content_formats` from the page detail API and render a small tab/toggle (HTML | Markdown | Text) when more than one exists; HTML tab (sandboxed iframe, unchanged) is default when present. Markdown tab fetches `/f/index.md` and renders with **react-markdown** (escapes embedded raw HTML by default — pinned by test) + a "Raw" toggle showing the source in a `<pre>`; Text tab fetches `/f/index.txt` as styled plain text. Serving route `/f/{path}` must emit the correct content type for `.md`/`.txt` with the same sandbox CSP headers.
- **D7 — Extension UI.** Session options gain `downloadHtml`/`downloadContentAsText`. When HTML is unchecked and a text mode is the only output, the options UI disables (with a short hint) the images/assets/documents/single-file toggles instead of silently ignoring them; no other UI change.
- **D8 — Compatibility & deploy order.** All wire changes additive: old monolith → new backend (unknown fields ignored) and new monolith → old backend (text parts dropped, HTML page still stored) both degrade gracefully. Ship order: `pagepocket/**` via CI (backend+frontend atomically), monolith rebuild on the user's explicit order afterward.
- **D9 — Size/meter honesty.** `size_bytes` = every stored document + assets, so the storage meter reflects text pages' real (small) footprint. Thumbnails: verify during implementation whether text-only pages get one; dashboard cards must fall back gracefully if not.

## Risks / Trade-offs

- [Rendered markdown as an XSS vector] → react-markdown escapes raw HTML by default; regression test asserts `<script>` in markdown source renders inert.
- [New frontend dependency (react-markdown)] → pinned, small, no transitive UI framework; accepted for correct rendering.
- [Text-only page pushed to a not-yet-rebuilt monolith/backend] → impossible in practice (backend ships first via CI; monolith only pushes new fields after rebuild); worst case is graceful degradation per D8.
- [Users confused by "HTML off" semantics] → inapplicable toggles disabled with hint (D7); selector labels unchanged.
- [Old share links / bookmarks] → unchanged; HTML pages render exactly as before (default tab).

## Migration Plan

1. Land everything in one commit on `main` → push `pagepocket`; CI green → `deploy-backend` + `deploy-frontend` auto-deploy (atomic pair).
2. Monolith rebuild happens on the user's explicit order (runbook §3) — until then the old local behavior persists, which is compatible.
3. Verify: text-only local download (raw `.md`), cloud text page + switcher at pagepocket.app, HTML+text toggle page, old HTML page regression.
4. Rollback: revert commit; feature is additive, no migrations, no stored-data changes for existing pages.

## Open Questions

- None blocking. (Parked: thumbnail generation for text pages — verify only; EPUB; server-side rendered-markdown caching.)
