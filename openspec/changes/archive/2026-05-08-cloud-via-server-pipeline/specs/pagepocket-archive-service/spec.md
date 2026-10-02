## MODIFIED Requirements

### Requirement: Page Ingestion from Extension Server
The Archive Service SHALL expose an `ArchiveService.IngestPage` RPC that receives a captured page (HTML + assets) from the extension server and persists it. When receiving pre-processed HTML with relative asset paths, the `sanitise_and_rewrite` function SHALL correctly match basenames (e.g., `images/photo.jpg` → basename `photo.jpg`) against the asset map.

#### Scenario: Successful ingest with pre-processed HTML
- **WHEN** `IngestPage` is called with `user_id`, `url`, `title`, `html_content` containing relative paths like `images/photo.jpg`, a list of `Asset { filename, content_type, data }`, and a unique `extension_job_id`
- **THEN** the service MUST generate a UUIDv4 `page_id`
- **AND** upload every asset to R2 under `{user_id}/{page_id}/assets/{filename}`
- **AND** rewrite every `src`/`href` in the HTML whose basename matches an asset filename to `/r2/{user_id}/{page_id}/assets/{filename}`
- **AND** upload the rewritten HTML to R2 under `{user_id}/{page_id}/index.html` with `content-type: text/html; charset=utf-8`
- **AND** insert a row into `archive_db.pages` with `id`, `user_id`, `url`, `title`, first 500 chars of body text as `preview_text`, the `index.html` R2 key, total byte size, and the `extension_job_id`
- **AND** call `SearchService.IndexPage` asynchronously with the extracted plain-text body
- **AND** return `IngestPageResponse { success=true, page_id=<uuid>, message="" }`

#### Scenario: Idempotent replay
- **WHEN** `IngestPage` is called with an `extension_job_id` that already exists in `archive_db.pages`
- **THEN** the service MUST NOT upload to R2 again and MUST NOT create a new row
- **AND** return `IngestPageResponse { success=true, page_id=<existing uuid> }`

#### Scenario: Empty title fallback
- **WHEN** the `title` field is empty
- **THEN** the service MUST use the `<title>` element from the HTML if present, else the `url`, as the stored title
