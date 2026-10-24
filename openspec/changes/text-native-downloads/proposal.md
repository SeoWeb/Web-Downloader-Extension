## Why

The download format selector is cosmetic today: markdown and content-as-text are additive extras dropped **inside** the full HTML zip (`content.md`/`content.txt` next to `index.html`), a lone text file is still wrapped in a zip, and PagePocket mode ignores the selector entirely — the cloud always receives and displays HTML (`zip_assembler.py:369-372` ignores markdown for cloud pushes; ingest schema has no format concept). Users who want a plain-text or markdown-only archive cannot get one, and the web dashboard can only ever show them HTML.

## What Changes

- **Local downloads**: selecting only markdown/content produces ONLY the text file(s) — no `index.html` on disk. Exactly one output file is delivered raw (`.md`/`.txt`); multiple files (e.g. multi-page markdown sets) are zipped. Images/assets/documents/single-file toggles are ignored in text-only modes. HTML+text selections keep today's bundle.
- **PagePocket cloud pages become multi-format**: the server pushes `index.md`/`index.txt` alongside `index.html`; a page with HTML unchecked pushes ONLY the text document. Ingest schema gains additive per-format content fields; each stored page records its available formats.
- **Viewer format switcher**: the dashboard and public share viewer show the page's available formats (HTML / Markdown / Text); HTML stays the default when present. Markdown renders formatted (raw HTML escaped) with a raw-source toggle; text pages display as plain text.
- **Extension plumbing**: session options now carry `downloadHtml` and `downloadContentAsText` (markdown already travels); the options UI disables inapplicable toggles in text-only modes.

## Capabilities

### New Capabilities

- `text-native-pages`: end-to-end semantics for text-native archives — the selection→artifact matrix, single-file-no-zip rule, multi-format page storage model, text-only cloud pages, viewer format switching and markdown raw view, and backward compatibility with HTML-only pages.

### Modified Capabilities

- `server-zip-assembly`: pure-text output modes and raw delivery of single-file outputs.
- `cloud-via-server`: cloud push carries markdown/text content; text-only push when HTML is off.
- `extension-server-client`: format flags propagate in session options; inapplicable toggles disabled.
- `pagepocket-proto-contracts`: additive `ContentDocument` on ingest; `content_formats` on page reads.
- `pagepocket-archive-service`: multi-format ingest storage (index.md/index.txt, meta formats, text-sourced search/preview).
- `pagepocket-ingest-rest`: optional `markdown_content`/`text_content` form parts.
- `pagepocket-frontend-page-viewer`: format switcher, rendered markdown + raw toggle, share-viewer parity.

## Impact

- **Monolith (`server/`)**: `zip_assembler.py` (text-only bundle, single-file raw delivery, cloud-push text generation — the branch currently ignores markdown), session option parsing, `archive_client.py` push payload; tests.
- **PagePocket backend**: `proto/archive.proto` (+ regen), archive-service ingest/storage/search, api-gateway ingest + page-detail routes; tests. Fully additive — old pages and old pushers keep working.
- **PagePocket frontend**: page-detail schema + viewer/share components (format switcher, markdown rendering via new `react-markdown` dep, raw toggle); tests. Deploys together with backend via CI as usual.
- **Extension**: session options + Filter UI toggle disabling; vitest/tsc.
- **Deploy**: `pagepocket/**` auto-deploys via CI; monolith (`server/`) rebuilds only on the user's explicit order (safe in both orders — changes are additive).
- **Out of scope**: EPUB/other formats, per-format quotas UI, re-rendering HTML pages as markdown on demand, changes to existing stored HTML pages.
