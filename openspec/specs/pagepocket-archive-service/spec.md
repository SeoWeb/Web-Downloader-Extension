# PagePocket Archive Service Specification

## Purpose

Persistence and retrieval of archived pages: ingestion from the extension server, R2 object storage layout, per-plan quota enforcement, page retrieval without presigned URLs, and deletion with dependency cleanup.

## Requirements

### Requirement: Page Ingestion from Extension Server
The Archive Service SHALL expose an `ArchiveService.IngestPage` RPC that receives a captured page (HTML + assets) from the extension server and persists it. HTML SHALL be processed to archive-relative asset paths (not absolute `/r2/...` URLs), with `<script>` elements removed and event-handler attributes plus `javascript:`/`data:text/html` URIs sanitized (see `archived-html-serving`). When receiving pre-processed HTML with relative asset paths, the `sanitise_and_rewrite` function SHALL correctly match basenames (e.g., `images/photo.jpg` → basename `photo.jpg`) against the asset map. Concurrent duplicate ingests SHALL converge idempotently, the extracted body SHALL be byte-safe truncated before being sent to search, and `extension_job_id` SHALL be length/charset-guarded. Ingest idempotency SHALL be user-scoped: `extension_job_id` uniqueness is enforced per `(user_id, extension_job_id)`, so one user's job id can never resolve to another user's page.

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

### Requirement: Quota Enforcement
The Archive Service SHALL enforce per-plan quotas (pages per month, total bytes) before writing to R2, using the `plan` supplied in the gRPC request, which SHALL be set only by trusted internal callers (the gateway from the authenticated JWT claim; the extension server from its server-side client binding) — the plan SHALL never be taken from data an end client controlled directly. The service SHALL attach a machine-readable `exhausted:<reason>` prefix to `RESOURCE_EXHAUSTED` details alongside the human message, and SHALL hold the quota row lock only across a short reserve transaction — never across the R2 upload phase.

#### Scenario: Under quota
- **WHEN** `IngestPage` is called and the user's `user_quotas.pages_this_month` is below the plan limit AND `total_bytes + request_size` is below the plan byte limit
- **THEN** the ingest proceeds and both counters are incremented atomically after successful R2 upload and DB insert

#### Scenario: Monthly page limit exceeded
- **WHEN** `user_quotas.pages_this_month` ≥ `PLAN_LIMITS[plan].pages_per_month`
- **THEN** the service MUST return gRPC `RESOURCE_EXHAUSTED` with details prefixed `exhausted:quota` and message `"Monthly page limit reached"`
- **AND** MUST NOT upload to R2 or create a `pages` row

#### Scenario: Storage byte limit exceeded
- **WHEN** `user_quotas.total_bytes + request_size` > `PLAN_LIMITS[plan].max_bytes`
- **THEN** the service MUST return gRPC `RESOURCE_EXHAUSTED` with details prefixed `exhausted:size` and message `"Storage limit reached"`

#### Scenario: Quota lock not held across R2 uploads
- **WHEN** two ingests for the same user overlap and the first is in its R2 upload phase
- **THEN** the second ingest MUST be able to complete its quota reserve/commit without hitting the InnoDB 50 s lock-wait timeout (the `FOR UPDATE` lock is released before uploads begin and the reservation is re-checked and confirmed after)

#### Scenario: Plan limits table
- **WHEN** the service evaluates quotas
- **THEN** it MUST use: `free` = 50 pages/month + 500 MB; `pro` = 99999 pages/month + 10 GB; `team` = 99999 pages/month + 50 GB
- **AND** `pages_this_month` MUST reset to 0 when `quota_reset_at` is in the past (rolled forward one month on next ingest)

#### Scenario: Plan comes from the authenticated context
- **WHEN** a gateway ingest request carries a form field or header suggesting a different plan than the JWT claim
- **THEN** the gateway sends the JWT claim's plan in the gRPC request
- **AND** the archive service enforces quotas against that plan only

### Requirement: Page Retrieval
The Archive Service SHALL expose `ArchiveService.GetPage`, `ArchiveService.GetPageContent`, and `ArchiveService.ListPages` RPCs that return pages owned by the requesting `user_id`. Ownership checks SHALL be mandatory: a request with an empty `user_id` SHALL be rejected with `INVALID_ARGUMENT` and SHALL never bypass the ownership check. `GetPageContent` SHALL NOT generate or return presigned URLs.

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

### Requirement: Page Deletion
The Archive Service SHALL expose an `ArchiveService.DeletePage` RPC that removes the page row first (committed, with quota decrement) and deletes R2 objects afterwards, then notifies share-service and library to purge dependent links — so a crash at any point leaves recoverable state and no dangling references.

#### Scenario: Successful delete
- **WHEN** `DeletePage` is called with `page_id` and `user_id` matching the row
- **THEN** the service MUST delete the row from `archive_db.pages` and decrement `user_quotas.total_bytes` by the row's `size_bytes` in one committed transaction BEFORE deleting any R2 object
- **AND** afterwards delete every object under R2 prefix `{user_id}/{page_id}/` and the thumbnail object `{user_id}/{page_id}.webp`
- **AND** call `SearchService.RemovePage` (with deadline), `ShareService.RevokeLinksForPage`, and `LibraryService.PurgePageLinks` (both best-effort, failures logged without failing the delete)
- **AND** return `StatusResponse { success=true }`

#### Scenario: Crash between commit and R2 deletion
- **WHEN** the service crashes after committing the row deletion but before completing R2 prefix deletion
- **THEN** the page MUST be gone from the user's view (no zombie page) and the leftover R2 objects MUST be plain orphans removable by the existing sweep (no unrecoverable state)

#### Scenario: Not found or cross-user
- **WHEN** the row does not exist or belongs to another user
- **THEN** the service MUST return `StatusResponse { success=false, message="not found" }` and perform no side effects

### Requirement: Intra-Service RPC Deadlines and Channel Reuse
The Archive Service SHALL attach an explicit deadline (30 s class) to every outbound service-to-service gRPC call (`IndexPage`, `RemovePage`, `ListCollectionPageIds`, `RevokeLinksForPage`, `PurgePageLinks`) and SHALL reuse memoized channels/stubs (the gateway's `grpc_clients` pattern) instead of creating a new channel per call.

#### Scenario: Wedged upstream cannot exhaust the worker pool
- **WHEN** the search-service stops responding and archive calls `IndexPage`
- **THEN** the call MUST fail with `DEADLINE_EXCEEDED` after its deadline, freeing the worker (no indefinite wedge of the 10-worker pool)

#### Scenario: Channels are memoized
- **WHEN** the archive-service makes N sequential calls to the same service within one process lifetime
- **THEN** the underlying gRPC channel MUST be created once and reused (no per-call channel teardown)

### Requirement: Collection-Scoped Listing Outage Semantics
When a collection-scoped listing cannot obtain the collection's page ids from the library service, the Archive Service SHALL surface `UNAVAILABLE` (which the gateway maps to 503 + Retry-After) and MUST NOT cache the result; it SHALL never silently degrade to an empty result set for a filtered request.

#### Scenario: Library outage during filtered list
- **WHEN** `ListPages` is called with a `collection_id` and the library RPC fails
- **THEN** the service MUST return `UNAVAILABLE` and MUST NOT write an empty page-id set into the cache
- **AND** the log message MUST state the true cause (library unavailability), not claim the result was "without collection filter"

#### Scenario: Healthy library still serves filtered lists
- **WHEN** the library RPC succeeds for a collection-scoped list
- **THEN** the service returns exactly the pages in that collection (behavior unchanged)

### Requirement: R2 Error Classification
The Archive Service SHALL classify R2 exceptions by cause: missing-key/404 errors map to gRPC `NOT_FOUND`, rate-limit/overload errors (`SlowDown`, 503-class, `ServiceUnavailable`) map to gRPC `UNAVAILABLE`, and remaining errors map to `INTERNAL` — never lumping overload into `NOT_FOUND`.

#### Scenario: R2 throttling during asset fetch
- **WHEN** R2 returns `SlowDown` while the service fetches an archived asset
- **THEN** the service MUST return `UNAVAILABLE` (gateway → 503 + Retry-After), so the gateway does not double-fetch or tell the client "file not found"

#### Scenario: Genuine missing object
- **WHEN** R2 raises `NoSuchKey` for a requested asset
- **THEN** the service MUST return `NOT_FOUND`

### Requirement: Pending-Index Retry Fidelity
`RetryPendingIndexing` SHALL re-read the page's authoritative HTML from R2 and re-extract the full body before re-indexing; it MUST NOT rebuild the index from the 500-character `preview_text`.

#### Scenario: Previously corrupted CJK page re-indexed fully
- **WHEN** a page whose `IndexPage` call failed the byte-length check is retried via `RetryPendingIndexing`
- **THEN** the retry MUST fetch `{user_id}/{page_id}/index.html` from R2 and index the complete extracted body (not the 500-char preview), producing a correct search entry

### Requirement: Archive file path hardening
`GetArchiveFile` SHALL reject any `file_path` that escapes the page's archive root: after normalization, the resolved path SHALL contain no `..` segments and SHALL NOT be absolute, regardless of object-store namespace semantics.

#### Scenario: Leading traversal is rejected
- **WHEN** `GetArchiveFile` is called with `file_path = "../other-page/index.html"` (leading `../`)
- **THEN** the service MUST return `INVALID_ARGUMENT` without any R2 lookup

#### Scenario: Embedded traversal is rejected
- **WHEN** `file_path` normalizes to a path containing `..` (e.g., `assets/../../secret`)
- **THEN** the service MUST return `INVALID_ARGUMENT`
