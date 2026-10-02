## ADDED Requirements

### Requirement: REST endpoint for page ingestion
The api-gateway SHALL expose `POST /api/v1/archive/pages/ingest` that accepts page uploads from the extension via `multipart/form-data` and routes them to the archive-service's existing `IngestPage` gRPC method.

#### Scenario: Successful page upload with assets
- **GIVEN** a user with a valid JWT access token
- **WHEN** the user sends `POST /api/v1/archive/pages/ingest` with `multipart/form-data` containing `url`, `title`, `html_content` (file), and `assets` (multiple files)
- **THEN** the gateway constructs an `IngestPageRequest` protobuf with the user's ID, the HTML bytes, and asset protos
- **AND** calls `archive_stub().IngestPage(request)`
- **AND** returns `{ success: true, page_id: "<uuid>", message: "", api_version: "v1" }`

#### Scenario: Upload without assets
- **GIVEN** a user with a valid JWT access token
- **WHEN** the user sends `POST /api/v1/archive/pages/ingest` with only `url` and `html_content` (no assets)
- **THEN** the request succeeds with an empty assets list
- **AND** returns `{ success: true, page_id: "<uuid>" }`

#### Scenario: Upload with title extraction
- **GIVEN** a user uploads a page without providing `title`
- **WHEN** the request reaches the archive-service
- **THEN** the archive-service extracts the title from the HTML `<title>` tag

#### Scenario: Idempotent upload
- **GIVEN** a page was previously uploaded with `extension_job_id` "job-123"
- **WHEN** the same `extension_job_id` is sent in a new upload
- **THEN** the archive-service returns the existing `page_id` without creating a duplicate
- **AND** no new R2 objects are uploaded

#### Scenario: Unauthorized request rejected
- **GIVEN** a request without a valid `Authorization: Bearer` header
- **WHEN** the request reaches the gateway
- **THEN** the gateway returns 401 with `{ detail: "Invalid token", api_version: "v1" }`

#### Scenario: Quota exceeded
- **GIVEN** the user has reached their storage quota
- **WHEN** the upload is processed
- **THEN** the archive-service returns RESOURCE_EXHAUSTED
- **AND** the gateway returns 402 with `{ detail: "Storage limit reached", api_version: "v1" }`

### Requirement: Multipart form field mapping
The REST endpoint SHALL map `multipart/form-data` fields to the gRPC `IngestPageRequest` message as follows:

| Form Field | gRPC Field | Type | Required |
|---|---|---|---|
| `url` | `url` | string (Form) | Yes |
| `title` | `title` | string (Form) | No |
| `html_content` | `html_content` | bytes (File) | Yes |
| `extension_job_id` | `extension_job_id` | string (Form) | No |
| `plan` | `plan` | string (Form) | No (defaults to JWT claim) |
| `assets` | `assets[]` | repeated Asset (Files) | No |

#### Scenario: Plan defaults to JWT claim
- **GIVEN** a user with plan "free" in their JWT
- **WHEN** the upload request does not include a `plan` field
- **THEN** the plan is read from `request.state.plan` (set by AuthMiddleware from the JWT)

#### Scenario: Asset file metadata preserved
- **GIVEN** an asset file uploaded with filename `style.css` and content-type `text/css`
- **WHEN** the gateway constructs the asset protobuf
- **THEN** `filename` is set to `style.css`
- **AND** `content_type` is set to `text/css`
- **AND** `data` contains the file bytes
