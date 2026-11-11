## ADDED Requirements

### Requirement: Page documents on ingest

`archive.proto` SHALL add `message PageDocument { string path; string title; string url; string content_format; bytes data; }` and a `repeated PageDocument pages` field on `IngestPageRequest`, using the next available tag numbers. The evolution SHALL be strictly additive: no existing field is renumbered, retyped, or reused, and an older archive-service SHALL tolerate the unknown field per proto3 semantics. Generated stubs SHALL be regenerated via `make proto` in the same change — never hand-edited — keeping the committed stubs equal to the `.proto` sources.

#### Scenario: New monolith pushes to old archive-service

- **WHEN** a newer monolith sends `IngestPage` with populated `pages` to an archive-service built from older stubs
- **THEN** the older service ignores the unknown `pages` field (proto3 unknown-field tolerance)
- **AND** ingest succeeds with the main-page content and no per-page documents are stored

#### Scenario: Stub regeneration is tracked

- **WHEN** `archive.proto` gains `PageDocument` and the `pages` field on `IngestPageRequest`
- **THEN** `make proto` regenerates the shared stubs and the generated output is committed in the same change
- **AND** no hand-edited generated files exist and the CI freshness check passes

### Requirement: Pages summary on page read

`PageResponse` SHALL carry a `repeated pages` summary list, each entry holding `path`, `title`, `url`, and `content_format` for one stored per-page document. The list SHALL be absent or empty for pages stored before per-page documents existed, so legacy pages and older readers are unaffected.

#### Scenario: Page with pages returns summaries

- **WHEN** `GetPage` returns a page whose ingest carried per-page documents
- **THEN** `PageResponse.pages` lists one summary per stored document with its `path`, `title`, `url`, and `content_format`

#### Scenario: Legacy page returns empty

- **WHEN** `GetPage` returns a page ingested before per-page documents existed
- **THEN** `PageResponse.pages` is empty (or the field is absent on the wire)
- **AND** the response remains decodable by older consumers unchanged
