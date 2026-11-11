## MODIFIED Requirements

### Requirement: Page Ingestion from Extension Server

The Archive Service SHALL expose an `ArchiveService.IngestPage` RPC that receives a captured page (HTML + assets) from the extension server and persists it. HTML SHALL be processed to archive-relative asset paths (not absolute `/r2/...` URLs), with `<script>` elements removed and event-handler attributes plus `javascript:`/`data:text/html` URIs sanitized (see `archived-html-serving`). When receiving pre-processed HTML with relative asset paths, the `sanitise_and_rewrite` function SHALL correctly match basenames (e.g., `images/photo.jpg` → basename `photo.jpg`) against the asset map. Concurrent duplicate ingests SHALL converge idempotently, the extracted body SHALL be byte-safe truncated before being sent to search, and `extension_job_id` SHALL be length/charset-guarded. Ingest idempotency SHALL be user-scoped: `extension_job_id` uniqueness is enforced per `(user_id, extension_job_id)`, so one user's job id can never resolve to another user's page. Ingest SHALL additionally accept the additive `repeated PageDocument pages` field: each document SHALL be stored at `{user_id}/{page_id}/pages/<path>` under the page's R2 prefix, the per-page manifest (`path`, `title`, `url`, `content_format`) SHALL be recorded in the page's `meta.json`, and the pages' bytes SHALL be included in the `size_bytes` quota accounting. Ingests without `pages` SHALL behave exactly as before.

#### Scenario: Successful ingest with pre-processed HTML

- **WHEN** `IngestPage` is called with `user_id`, `url`, `title`, `html_content` containing archive-relative asset references (e.g. `images/photo.jpg`), a list of `Asset { filename, content_type, data }`, and a unique `extension_job_id`
- **THEN** the service MUST generate a UUIDv4 `page_id`
- **AND** upload every asset to R2 under `{user_id}/{page_id}/assets/{filename}`
- **AND** rewrite every `src`/`href` in the HTML whose basename matches an asset filename to its archive-relative path within the page (never to an absolute `/r2/...` URL)
- **AND** upload the sanitized, rewritten HTML to R2 under `{user_id}/{page_id}/index.html` with `content-type: text/html; charset=utf-8`
- **AND** insert a row into `archive_db.pages` with `id`, `user_id`, `url`, `title`, first 500 chars of body text as `preview_text`, the `index.html` R2 key, total byte size, and the `extension_job_id`
- **AND** call `SearchService.IndexPage` asynchronously (with an explicit deadline) with the extracted plain-text body truncated by bytes (UTF-8-safe), not by characters
- **AND** return `IngestPageResponse { success=true, page_id=<uuid>, message="" }`

#### Scenario: Idempotent replay is scoped to the owner

- **WHEN** `IngestPage` is called with an `extension_job_id` that already exists for the same `user_id`
- **THEN** the service MUST NOT upload to R2 again and MUST NOT create a new row
- **AND** return `IngestPageResponse { success=true, page_id=<existing uuid> }`

#### Scenario: Concurrent same-job retries converge

- **WHEN** two `IngestPage` calls with the same `(user_id, extension_job_id)` race past the existence check and the loser hits the unique-index `IntegrityError`
- **THEN** the service MUST roll back, re-select the existing row, clean up its just-uploaded R2 prefix, and return `IngestPageResponse { success=true, page_id=<existing uuid> }`
- **AND** MUST NOT surface gRPC `UNKNOWN`/HTTP 500 nor perform a full duplicate R2 upload

#### Scenario: Oversized extension_job_id rejected

- **WHEN** `IngestPage` is called with an `extension_job_id` exceeding 36 characters or containing an illegal charset that slipped past the gateway
- **THEN** the service MUST return `INVALID_ARGUMENT` (never a column-overflow 500)

#### Scenario: Empty title fallback

- **WHEN** the `title` field is empty
- **THEN** the service MUST use the `<title>` element from the HTML if present, else the `url`, as the stored title

#### Scenario: Job id collision across users cannot shadow a page

- **WHEN** `IngestPage` is called with an `extension_job_id` that exists but belongs to a different `user_id`
- **THEN** the service MUST treat it as a new ingest for this user (new `page_id`)
- **AND** MUST NOT return, modify, or delete the other user's page

#### Scenario: Archived HTML is sanitized before persistence

- **WHEN** `html_content` contains `<script>` blocks, `on*` handler attributes, or `javascript:` URIs
- **THEN** the persisted HTML contains none of them
- **AND** the extracted plain-text preview is unchanged in meaning

#### Scenario: Multi-document ingest is stored under pages/

- **WHEN** `IngestPage` is called with `pages` carrying per-page documents (e.g. markdown/text with `path = about.md`)
- **THEN** each document's bytes are stored at `{user_id}/{page_id}/pages/<path>` (slash-preserving keys, same path handling as assets)

#### Scenario: Pages manifest recorded in meta.json

- **WHEN** `IngestPage` is called with per-page documents
- **THEN** the page's `meta.json` records a `pages` list with each document's `path`, `title`, `url`, and `content_format`

#### Scenario: Quota accounting includes pages bytes

- **WHEN** an ingest carries per-page documents
- **THEN** the documents' byte sizes are included in the `request_size` used for the quota pre-check and in the `size_bytes` recorded for the page

#### Scenario: Ingest without pages is unchanged

- **WHEN** a legacy monolith calls `IngestPage` with no `pages` field populated
- **THEN** the ingest behaves exactly as before (no `pages/` objects, no manifest entries), and the page remains fully retrievable and exportable

### Requirement: Page Retrieval

The Archive Service SHALL expose `ArchiveService.GetPage`, `ArchiveService.GetPageContent`, and `ArchiveService.ListPages` RPCs that return pages owned by the requesting `user_id`. Ownership checks SHALL be mandatory: a request with an empty `user_id` SHALL be rejected with `INVALID_ARGUMENT` and SHALL never bypass the ownership check. `GetPageContent` SHALL NOT generate or return presigned URLs. `GetPage` SHALL additionally return the stored pages summary list (`path`, `title`, `url`, `content_format` per document) read from the page's manifest; the list is empty for pages stored before per-page documents existed.

#### Scenario: Get metadata

- **WHEN** `GetPage` is called with `page_id` and `user_id`
- **THEN** if the row exists and `pages.user_id` matches, return a `PageResponse` with all metadata fields (excluding the removed `r2_key` field)
- **AND** if no match, return `NOT_FOUND`

#### Scenario: Get viewer URL (presigned URLs removed)

- **WHEN** `GetPageContent` is called with `page_id` and `user_id`
- **THEN** the service MUST NOT generate or return an R2 presigned GET URL
- **AND** `PageContentResponse` MUST NOT contain `signed_url` (the field's tag is reserved); archived content is delivered via the sandboxed asset-serving path only

#### Scenario: Empty user_id is never a wildcard

- **WHEN** `GetPageContent` or `GetArchiveFile` is called with an empty `user_id`
- **THEN** the service MUST return `INVALID_ARGUMENT`
- **AND** MUST NOT return content for any page regardless of existence

#### Scenario: List pagination and sort

- **WHEN** `ListPages` is called with `user_id`, `page`, `page_size`, `sort_by ∈ {archived_at, title}`
- **THEN** the service MUST return a page-sized slice ordered by the requested column (descending for `archived_at`, ascending for `title`) along with the total row count for that user

#### Scenario: Cross-user isolation

- **WHEN** any Get/List RPC is called with a `user_id` that does not own the target `page_id`
- **THEN** the service MUST return `NOT_FOUND` (never leak existence across users)

#### Scenario: Detail exposes the pages list

- **WHEN** `GetPage` is called for a page whose `meta.json` records a `pages` manifest
- **THEN** the `PageResponse` carries the pages summary list (each entry with `path`, `title`, `url`, `content_format`)
- **AND** a legacy page (no manifest) returns an empty list

### Requirement: Page ZIP Export

The archive service SHALL expose a streaming `ExportPage` RPC that assembles a downloadable ZIP of an archived page from its R2 prefix. Stored per-page documents (`pages/<path>` objects) SHALL be included in exports automatically as part of the prefix listing, at their relative names under a `pages/` directory in the zip.

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

#### Scenario: Exported zip contains pages/ directory entries

- **WHEN** `ExportPage` is called for a page whose ingest stored per-page documents
- **THEN** the zip contains the stored `pages/<path>` objects at their relative names (a `pages/` directory in the extracted layout)
- **AND** no export-specific change is needed for them to appear (they are picked up by the existing prefix listing)
