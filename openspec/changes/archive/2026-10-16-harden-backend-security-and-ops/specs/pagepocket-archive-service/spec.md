## MODIFIED Requirements

### Requirement: Page Ingestion from Extension Server
The Archive Service SHALL expose an `ArchiveService.IngestPage` RPC that receives a captured page (HTML + assets) from the extension server and persists it. HTML SHALL be processed to archive-relative asset paths (not absolute `/r2/...` URLs), with `<script>` elements removed and event-handler attributes plus `javascript:`/`data:text/html` URIs sanitized (see `archived-html-serving`). Ingest idempotency SHALL be user-scoped: `extension_job_id` uniqueness is enforced per `(user_id, extension_job_id)`, so one user's job id can never resolve to another user's page.

#### Scenario: Successful ingest with pre-processed HTML
- **WHEN** `IngestPage` is called with `user_id`, `url`, `title`, `html_content` containing archive-relative asset references, a list of `Asset { filename, content_type, data }`, and a unique `extension_job_id`
- **THEN** the service MUST generate a UUIDv4 `page_id`
- **AND** upload every asset to R2 under `{user_id}/{page_id}/assets/{filename}`
- **AND** rewrite asset references in the HTML to their archive-relative paths within the page
- **AND** upload the sanitized, rewritten HTML to R2 under `{user_id}/{page_id}/index.html` with `content-type: text/html; charset=utf-8`
- **AND** insert a row into `archive_db.pages` and call `SearchService.IndexPage` asynchronously
- **AND** return `IngestPageResponse { success=true, page_id=<uuid>, message="" }`

#### Scenario: Idempotent replay is scoped to the owner
- **WHEN** `IngestPage` is called with an `extension_job_id` that already exists for the same `user_id`
- **THEN** the service MUST NOT upload to R2 again and MUST NOT create a new row
- **AND** return `IngestPageResponse { success=true, page_id=<existing uuid> }`

#### Scenario: Job id collision across users cannot shadow a page
- **WHEN** `IngestPage` is called with an `extension_job_id` that exists but belongs to a different `user_id`
- **THEN** the service MUST treat it as a new ingest for this user (new `page_id`)
- **AND** MUST NOT return, modify, or delete the other user's page

#### Scenario: Archived HTML is sanitized before persistence
- **WHEN** `html_content` contains `<script>` blocks, `on*` handler attributes, or `javascript:` URIs
- **THEN** the persisted HTML contains none of them
- **AND** the extracted plain-text preview is unchanged in meaning

#### Scenario: Empty title fallback
- **WHEN** the `title` field is empty
- **THEN** the service MUST use the `<title>` element from the HTML if present, else the `url`, as the stored title

### Requirement: Quota Enforcement
The Archive Service SHALL enforce per-plan quotas (pages per month, total bytes) before writing to R2, using the `plan` supplied in the gRPC request, which SHALL be set only by trusted internal callers (the gateway from the authenticated JWT claim; the extension server from its server-side client binding). The plan SHALL never be taken from data an end client controlled directly.

#### Scenario: Under quota
- **WHEN** `IngestPage` is called and the user's `user_quotas.pages_this_month` is below the plan limit AND `total_bytes + request_size` is below the plan byte limit
- **THEN** the ingest proceeds and both counters are incremented atomically after successful R2 upload and DB insert

#### Scenario: Monthly page limit exceeded
- **WHEN** `user_quotas.pages_this_month` ≥ `PLAN_LIMITS[plan].pages_per_month`
- **THEN** the service MUST return gRPC `RESOURCE_EXHAUSTED` with message `"Monthly page limit reached"`
- **AND** MUST NOT upload to R2 or create a `pages` row

#### Scenario: Storage byte limit exceeded
- **WHEN** `user_quotas.total_bytes + request_size` > `PLAN_LIMITS[plan].max_bytes`
- **THEN** the service MUST return gRPC `RESOURCE_EXHAUSTED` with message `"Storage limit reached"`

#### Scenario: Plan limits table
- **WHEN** the service evaluates quotas
- **THEN** it MUST use: `free` = 50 pages/month + 500 MB; `pro` = 99999 pages/month + 10 GB; `team` = 99999 pages/month + 50 GB
- **AND** `pages_this_month` MUST reset to 0 when `quota_reset_at` is in the past

#### Scenario: Plan comes from the authenticated context
- **WHEN** a gateway ingest request carries a form field or header suggesting a different plan than the JWT claim
- **THEN** the gateway sends the JWT claim's plan in the gRPC request
- **AND** the archive service enforces quotas against that plan only

### Requirement: Page Retrieval
The Archive Service SHALL expose `ArchiveService.GetPage`, `ArchiveService.GetPageContent`, and `ArchiveService.ListPages` RPCs that return pages owned by the requesting `user_id`. Ownership checks SHALL be mandatory: a request with an empty `user_id` SHALL be rejected with `INVALID_ARGUMENT` and SHALL never bypass the ownership check.

#### Scenario: Get metadata
- **WHEN** `GetPage` is called with `page_id` and `user_id`
- **THEN** if the row exists and `pages.user_id` matches, return a `PageResponse` with all metadata fields
- **AND** if no match, return `NOT_FOUND`

#### Scenario: Empty user_id is never a wildcard
- **WHEN** `GetPageContent` or `GetArchiveFile` is called with an empty `user_id`
- **THEN** the service MUST return `INVALID_ARGUMENT`
- **AND** MUST NOT return content for any page regardless of existence

#### Scenario: Get viewer URL
- **WHEN** `GetPageContent` is called with `page_id` and the owning `user_id`
- **THEN** the service MUST generate an R2 presigned GET URL for `pages.r2_key` with an expiry of 3600 seconds
- **AND** return `PageContentResponse { signed_url, expires_at=<now+3600> }`

#### Scenario: List pagination and sort
- **WHEN** `ListPages` is called with `user_id`, `page`, `page_size`, `sort_by ∈ {archived_at, title}`
- **THEN** the service MUST return a page-sized slice ordered by the requested column (descending for `archived_at`, ascending for `title`) along with the total row count for that user

#### Scenario: Cross-user isolation
- **WHEN** any Get/List RPC is called with a `user_id` that does not own the target `page_id`
- **THEN** the service MUST return `NOT_FOUND` (never leak existence across users)

## ADDED Requirements

### Requirement: Archive file path hardening
`GetArchiveFile` SHALL reject any `file_path` that escapes the page's archive root: after normalization, the resolved path SHALL contain no `..` segments and SHALL NOT be absolute, regardless of object-store namespace semantics.

#### Scenario: Leading traversal is rejected
- **WHEN** `GetArchiveFile` is called with `file_path = "../other-page/index.html"` (leading `../`)
- **THEN** the service MUST return `INVALID_ARGUMENT` without any R2 lookup

#### Scenario: Embedded traversal is rejected
- **WHEN** `file_path` normalizes to a path containing `..` (e.g., `assets/../../secret`)
- **THEN** the service MUST return `INVALID_ARGUMENT`
