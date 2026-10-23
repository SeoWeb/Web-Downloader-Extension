## Why

Users can already save a page's raw text (`content.txt`), but it is unstructured glue — no headings, links, or readability. A Markdown export gives professionals a portable, structured document they can paste into notes/Obsidian/Notion with links intact. The conversion pipeline already uploads full raw HTML to the server, so high-fidelity conversion can be added server-side with no extension capture changes.

## What Changes

- Add a `downloadContentAsMarkdown` download option (new "Download content as Markdown" checkbox, independent of the existing "Download content as text" checkbox; both may be enabled).
- Server-side HTML→Markdown conversion in the monolith at assembly time using `markdownify` (pure-Python, bs4-based — no new heavy deps): runs on the merged HTML **before** Phase-2 URL rewriting, so markdown links/images keep **original absolute URLs**; `script/style/noscript/template/svg` are stripped first (same rule as text extraction); relative URLs resolve against the page's original URL.
- When the option is on, multi-file ZIPs contain:
  - `content.md` in the ZIP root (main page markdown)
  - `pages/<hash>.md` beside every `pages/<hash>.html` for linked-pages downloads, each stamped with its source URL
- Single-file mode and the cloud push branch are unchanged in v1 (the existing option model already forces granular content options off under `singleFile`; cloud-branch markdown is deferred).
- Extension: option plumbed through filter types/store/hook/UI + i18n (en + sync to all locales) and sent in `createSession`. No conversion code in the extension — the "no client-side HTML processing" constraint (`html-processing` spec) is preserved.

## Capabilities

### New Capabilities

- `server-markdown-export`: Server-side HTML→Markdown export — converter behavior (stripping, URL resolution, conversion timing), `content.md` and `pages/<hash>.md` ZIP outputs, source-URL stamping, and option gating semantics.

### Modified Capabilities

- `server-api`: Session Creation accepts the new `downloadContentAsMarkdown` option (persisted in the session options blob like `singleFile`).
- `user-interface`: Filter panel gains the "Download content as Markdown" checkbox with the same interaction rules as other content options (counts as content on its own; forced off under single-file).
- `extension-server-client`: Session creation payload carries the new option flag.

## Impact

- **Server (monolith, `server/`)**: new `markdown_converter.py` service; `markdownify` added to `requirements.txt`; `SessionOptions` model + `zip_assembler.py` (convert + embed in ZIP and linked-page loops); new tests (`test_markdown_converter.py`, `test_zip_assembler.py` extensions). CI already runs monolith pytest; deploy is the manual monolith rebuild per runbook §3/§13.
- **Extension (`src/`)**: `filterTypes.ts`, `filterStore.ts`, `useFilterOptions.ts`, `Filter.tsx`, `server-client.ts` (`SessionOptions` + `createSession`), `download-core.ts` (pass flag), `en.json` + locale sync. Ships via normal CI extension artifact.
- **No changes**: upload routes (no new endpoint — the server converts the HTML it already stores), `content.txt` behavior, single-file output, cloud push branch, local-mode (does not exist — server mode is the only path).
- **Deferrals (v2)**: single-file markdown embed, cloud-push markdown, per-page front-matter metadata beyond source URL.
