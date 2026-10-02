## ADDED Requirements

### Requirement: Bucket Layout
Cloudflare R2 SHALL be used as the canonical object store with two buckets and the following key layout.

#### Scenario: Pages bucket layout
- **WHEN** a page is successfully ingested with `user_id=U` and `page_id=P`
- **THEN** the `pagepocket-pages` bucket MUST contain:
  - `U/P/index.html` — self-contained HTML with rewritten asset references
  - `U/P/assets/<filename>` — every uploaded asset (CSS, image, font, etc.), original filename preserved
  - `U/P/meta.json` — `{ title, url, archived_at, size_bytes }` for downstream tools
- **AND** no other objects MUST be written outside the `U/P/` prefix for that page

#### Scenario: Thumbnails bucket layout
- **WHEN** a thumbnail is generated for a page
- **THEN** the `pagepocket-thumbnails` bucket MUST contain `U/P.webp` sized approximately 400×250

### Requirement: S3-Compatible Client
The backend SHALL use a shared `R2Client` wrapper built on `boto3` with signature version `s3v4` and `region_name="auto"`.

#### Scenario: Client initialisation
- **WHEN** any service instantiates `R2Client`
- **THEN** it MUST read `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` from environment
- **AND** configure `boto3.client("s3", ..., config=Config(signature_version="s3v4"), region_name="auto")`

#### Scenario: Upload
- **WHEN** `R2Client.upload(key, data, content_type)` is called
- **THEN** it MUST call `put_object(Bucket, Key=key, Body=data, ContentType=content_type)` and return the `key`

#### Scenario: Delete prefix
- **WHEN** `R2Client.delete_prefix(prefix)` is called (used by archive deletion)
- **THEN** the client MUST page through `list_objects_v2` and call `delete_objects` in batches until no keys remain under the prefix

### Requirement: Presigned URLs
Viewer access to page objects SHALL always go through short-lived presigned GET URLs; R2 buckets MUST NOT be publicly readable.

#### Scenario: Presign viewer URL
- **WHEN** `R2Client.presign(key, expires=3600)` is called
- **THEN** it MUST return a presigned GET URL valid for 3600 seconds (default) signed with s3v4

#### Scenario: Bucket privacy
- **WHEN** the `pagepocket-pages` and `pagepocket-thumbnails` buckets are provisioned
- **THEN** their public access MUST be disabled; reads MUST only succeed through presigned URLs

### Requirement: Credential Hygiene
R2 credentials SHALL only be held by services that need to write (`archive-service`) or generate presigned URLs; other services MUST NOT receive the secret key.

#### Scenario: Service credential scope
- **WHEN** a service is deployed
- **THEN** only `archive-service` and any future thumbnail worker MUST have `R2_SECRET_ACCESS_KEY` in environment
- **AND** `auth-service`, `library-service`, `search-service`, `share-service`, and `api-gateway` MUST NOT receive R2 credentials
