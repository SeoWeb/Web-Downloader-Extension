## ADDED Requirements

### Requirement: Text content parts on REST ingest

The gateway ingest route SHALL accept optional file parts `markdown_content` and `text_content` alongside the existing `html_content`, mapping them into the RPC's `content_documents`. Parts SHALL be optional; absence preserves today's behavior exactly.

#### Scenario: REST multi-format ingest

- **WHEN** `POST /pages/ingest` is called with `html_content` and `markdown_content` parts
- **THEN** the gateway forwards both as content documents and returns the ingest response with `content_formats`

#### Scenario: Legacy ingest unchanged

- **WHEN** `POST /pages/ingest` is called with only `html_content`
- **THEN** the request succeeds exactly as before
