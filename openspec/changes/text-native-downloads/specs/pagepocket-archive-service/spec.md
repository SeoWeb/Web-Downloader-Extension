## ADDED Requirements

### Requirement: Multi-format page storage

The archive-service SHALL store each ingested content document as its own object — `index.html` as today, plus `index.md` (`text/markdown; charset=utf-8`) and `index.txt` (`text/plain; charset=utf-8`) — recording the available formats in `meta.json` (`content_formats`, html first when present). HTML sanitization and asset rewriting SHALL apply only to HTML content. `size_bytes` SHALL include every stored document. Search and preview text SHALL be extracted from the HTML when present, otherwise from the text document. A page SHALL require at least one content document to ingest. Page reads (detail RPC) SHALL return `content_formats`.

#### Scenario: Formats stored and reported

- **WHEN** a page is ingested with html + markdown + text documents
- **THEN** R2 holds `index.html`, `index.md`, `index.txt`; `meta.json` lists all three formats; the detail response reports them

#### Scenario: Text-only page searchable

- **WHEN** a markdown-only page is ingested and searched
- **THEN** the search index and preview text derive from the markdown content

#### Scenario: Empty content rejected

- **WHEN** a request carries no `html_content` and no content documents
- **THEN** ingest is rejected exactly as an empty HTML push is today

#### Scenario: Serving text content

- **WHEN** the file-serving route serves `index.md` or `index.txt`
- **THEN** it responds with the correct content type and the same sandbox CSP headers as HTML
