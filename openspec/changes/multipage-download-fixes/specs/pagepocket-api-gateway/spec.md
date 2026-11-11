## MODIFIED Requirements

### Requirement: Archive REST Routes

The API Gateway SHALL expose REST routes that map 1:1 to `ArchiveService` RPCs for page listing, viewing, and deletion. The page detail route `GET /api/v1/archive/pages/{page_id}` SHALL include the pages summary list (each entry with `path`, `title`, `url`, `content_format`) from the archive service's `PageResponse` in its JSON response; the field is tolerant — absent or empty for legacy pages.

#### Scenario: List pages

- **WHEN** a client sends `GET /api/v1/archive/pages?page=<n>&page_size=<m>&sort_by=<archived_at|title>`
- **THEN** the gateway MUST call `ArchiveService.ListPages` with the authenticated `user_id`
- **AND** return `{ "pages": [...], "total": <int> }`

#### Scenario: View page (no presigned URL)

- **WHEN** a client sends `GET /api/v1/archive/pages/{page_id}/view`
- **THEN** the gateway MUST call `ArchiveService.GetPageContent` with the authenticated `user_id` and `page_id`
- **AND** the response MUST NOT contain any presigned or R2 URL field (the `url`/`signed_url` contract is removed; archived content is delivered exclusively via the sandboxed asset routes)

#### Scenario: Delete page

- **WHEN** a client sends `DELETE /api/v1/archive/pages/{page_id}`
- **THEN** the gateway MUST call `ArchiveService.DeletePage` with the authenticated `user_id`
- **AND** return `{ "success": true | false }`

#### Scenario: Detail response includes pages list

- **WHEN** a client sends `GET /api/v1/archive/pages/{page_id}` for a page whose ingest carried per-page documents
- **THEN** the response MUST include the pages summary list with each document's `path`, `title`, `url`, and `content_format`
- **AND** for a legacy page the field is absent or empty (tolerant pass-through, no gateway-side synthesis)
