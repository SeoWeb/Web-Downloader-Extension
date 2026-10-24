## ADDED Requirements

### Requirement: Content documents on ingest

`IngestPageRequest` SHALL gain an additive `repeated ContentDocument content_documents` field where `ContentDocument { string content_format = 1; bytes data = 2; }` with `content_format` ∈ `html | markdown | text`. `html_content` SHALL become optional (empty when the page is text-only). Ingest responses and page-read responses SHALL report `repeated string content_formats`. Only additive field numbers SHALL be used so older pushers and readers keep working.

#### Scenario: Multi-format ingest round-trip

- **WHEN** a request carries `html_content` plus a markdown `content_documents` entry
- **THEN** ingest succeeds and the response reports `content_formats` containing both `html` and `markdown`

#### Scenario: Text-only ingest

- **WHEN** a request carries empty `html_content` and a single markdown document
- **THEN** ingest succeeds and reports `content_formats = ["markdown"]`

#### Scenario: Old pusher unaffected

- **WHEN** a request without `content_documents` is ingested
- **THEN** behavior is identical to today
