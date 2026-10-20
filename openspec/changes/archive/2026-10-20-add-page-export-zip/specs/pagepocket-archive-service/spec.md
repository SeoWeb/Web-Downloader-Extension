## ADDED Requirements

### Requirement: Page ZIP Export

The archive service SHALL expose a streaming `ExportPage` RPC that assembles a downloadable ZIP of an archived page from its R2 prefix.

#### Scenario: ZIP mirrors the storage prefix

- **WHEN** `ExportPage` is called for an existing page owned by the requesting user
- **THEN** the returned stream MUST be a valid zip64 ZIP containing exactly the page's stored objects: `index.html`, `assets/**`, and `meta.json`, with relative paths preserved so the extracted `index.html` renders offline without modification
- **AND** the page thumbnail and any objects outside `{user_id}/{page_id}/` MUST NOT be included

#### Scenario: Works without a manifest

- **WHEN** a page has no asset manifest recorded (any page saved before this change)
- **THEN** the export MUST still succeed by enumerating objects via R2 prefix listing

#### Scenario: Streaming bounds

- **WHEN** the export stream is consumed
- **THEN** chunks MUST NOT exceed a shared, documented maximum (512 KB), and the service MUST NOT hold the whole uncompressed archive in RAM at any point

#### Scenario: Deterministic assembly

- **WHEN** the same page is exported twice without changes
- **THEN** entry order MUST be stable (`index.html`, `meta.json`, then assets sorted by key)

#### Scenario: Error semantics

- **WHEN** the page does not exist or is not owned by the requesting user
- **THEN** the RPC MUST return NOT_FOUND
- **WHEN** R2 listing or reads fail
- **THEN** the failure MUST be classified per the existing R2 error classification requirement

### Requirement: Export Authorization

Page export SHALL enforce the same ownership rules as page retrieval.

#### Scenario: Ownership enforced

- **WHEN** `ExportPage` is called with a `user_id` that does not own the page
- **THEN** the RPC MUST behave identically to a missing page (NOT_FOUND), never leaking existence
