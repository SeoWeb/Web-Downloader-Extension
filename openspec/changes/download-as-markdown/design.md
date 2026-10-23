## Context

The extension captures raw HTML and uploads it to the monolith (`server/`), which merges scroll chunks into the full page, rewrites URLs to archive-relative paths, and assembles the deliverable (ZIP or single file). A plain-text export already exists: the extension extracts `content.txt` client-side (`src/background/resources.ts` → `uploadContent`) and the server stores it verbatim. There is no Markdown support anywhere in the repo (no turndown, no markdownify, no converter code).

Key facts driving the design (all verified against the code):

- The assembler's Phase-1 merge (`zip_assembler.py:123-126` → `html_merger.py`) produces the complete merged HTML — including lazy-loaded content from scroll chunks — with **original URLs intact**. URL rewriting happens later, in Phase 2 (`zip_assembler.py:142+` → `html_converter.py`).
- The monolith already depends on `beautifulsoup4` + `lxml` (`server/requirements.txt:12-14`).
- The monolith stores each linked page's merged HTML and its original URL (`html_merger.py:791-830`; `page_url` on chunk rows) and exposes `linked_page_htmls` to the ZIP loop.
- `server/**` is CI-tested but absent from deploy path filters — the monolith ships via the manual host rebuild (runbook §3 step 3b, §13/§14 gotcha: host checkout must be reset to `origin/pagepocket` first).
- The `html-processing` spec forbids client-side HTML processing; the extension is limited to capture + upload.
- Single-file mode already forces all granular content options off (`filterStore.validateFilterOptions`), and the cloud push branch reads `content.txt` only.

## Goals / Non-Goals

**Goals:**

- One checkbox that produces clean, structured Markdown for the main page (`content.md`) and, with linked pages enabled, one `pages/<hash>.md` per linked page — all with original absolute URLs.
- Conversion quality better than client-side extraction could achieve (merged HTML, server-grade libs).
- Zero new upload endpoints, zero extension bundle cost, no change to existing outputs (`index.html`, `content.txt`, assets).

**Non-Goals:**

- Markdown embedding in single-file output (deferred; the option model already excludes it there).
- Markdown in the cloud push branch (deferred).
- Readability/main-content detection (full-document conversion; nav/footer text is in scope — same as `content.txt`).
- Front-matter beyond the source-URL stamp; combined-file markdown alternative (superseded by per-page files per operator decision).

## Decisions

- **D1 — Convert server-side, not client-side.** `markdownify` (pure-Python, bs4-based) in the monolith. Alternatives: turndown in the extension (rejected: violates `html-processing` "no client-side HTML processing", needs a DOM shim in the SW, sees only the initial HTML — misses lazy-loaded content, duplicates linked-page logic); `html2text` (acceptable fallback, but markdownify's bs4 base matches the existing stack and output is cleaner for links/images).
- **D2 — Convert post-merge, pre-URL-rewrite.** Insert conversion between Phase 1 (merge) and Phase 2 (rewrite) in `assemble_session`. This yields original absolute URLs for free and sees the fully merged document. Alternative (converting Phase-2 output) would require reverse-mapping archive paths via `filename_map`/`resources.original_url` — needless complexity.
- **D3 — Preprocess before converting.** Strip `script, style, noscript, template, svg` (parity with the extension's `NON_CONTENT_SELECTOR`) and resolve relative hrefs/srcs against the page's original URL (`urljoin`) before handing the soup to markdownify.
- **D4 — Per-page linked markdown files with a source stamp.** `pages/<hash>.md` mirrors the existing `pages/<hash>.html` mapping (same hashes, same loop), each file beginning with an HTML-comment-style stamp line: `<!-- source: <original-url> -->` followed by the page title as an H1 when available. Chosen over one combined `content.md` with `--- URL ---` delimiters (operator decision) — cleaner for import into note tools; costs one extra `zf.writestr` per page in the existing loop.
- **D5 — Option plumbing via the existing options blob.** `downloadContentAsMarkdown: bool = False` joins `SessionOptions` (server pydantic model + extension `SessionOptions` interface) and rides the `POST /api/v1/sessions` body like `singleFile`. The assembler reads it from `session.options` (same precedent as `singleFile` at `zip_assembler.py:115`).
- **D6 — Failure isolation.** Conversion runs in `asyncio.to_thread` (same pattern as merge) wrapped in try/except per document; on failure, log and omit that markdown file only. Assembly must never fail because of markdown.
- **D7 — Gating semantics.** Default off; independent of `downloadContentAsText`; counts as a content selection in the extension's "nothing selected" guard; forced off under `singleFile` by the existing validation (no new rule needed); ignored by the cloud branch in v1 (documented in code).
- **D8 — Deploy.** Server part ships via the manual monolith rebuild (host `git fetch` + `reset --hard origin/pagepocket`, `docker compose build app`, `up -d`, health + 401 probes per runbook §3); extension part ships via the normal CI extension artifact. No CI path-filter changes.

## Risks / Trade-offs

- [Full-document markdown includes nav/footer boilerplate] → Accepted for v1 (parity with `content.txt`); readability filtering is a possible v2 refinement, not a blocker.
- [markdownify output quality on exotic markup (tables, nested lists)] → Converter test suite pins the common cases (headings, links, images, code, tables, lists); exotic constructs degrade to plain text, never to failure (D6).
- [Assembly time grows with linked-page count] → Conversion is O(page HTML) with a fast pure-Python lib and runs off the event loop; if it ever shows in the assembly-timeout envelope, batch/parallelize like CSS conversion — noted, not preemptively built.
- [ZIP size doubles for text-heavy pages when both text options are on] → Only when the user opts in; `content.md` is typically a fraction of `index.html`.
- [Manual monolith deploy is error-prone (stale checkout gotcha)] → Runbook §13/§14 documents `git reset --hard origin/pagepocket` before rebuild; deploy task includes the verification probes.
- [Locale drift for the new UI strings] → Add keys to `en.json` and run `scripts/sync-locales.mjs`; `tests/unit/locale-coverage.test.ts` enforces completeness.

## Migration Plan

1. Merge server + extension code (single PR/commit chain on `main` → push `pagepocket`).
2. CI green (extension job + monolith pytest; frontend/backend deploys unaffected).
3. Manual monolith rebuild on the host (runbook §3) — seconds of downtime, DB untouched; the new option is inert for sessions created without it, so deploy order does not matter.
4. Operator verifies: rebuild extension locally, run one content-only download and one linked-pages download with the checkbox on.
5. Rollback: revert is trivial — the feature is fully gated behind the option; without the flag, behavior is byte-identical to today.

## Open Questions

- None blocking. (v2 candidates parked: single-file markdown embed, cloud-push markdown, readability filtering, YAML front-matter metadata.)
