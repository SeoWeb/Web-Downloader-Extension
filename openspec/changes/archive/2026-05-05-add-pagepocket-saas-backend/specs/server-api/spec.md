## ADDED Requirements

### Requirement: Optional Cloud-Archive Forwarding
The extension server SHALL support an optional post-finalization hook that pushes the finalized page to `ArchiveService.IngestPage` when the env var `ARCHIVE_SERVICE_ADDR` is set.

#### Scenario: Cloud archiving enabled
- **WHEN** the extension server finalizes a session successfully AND `ARCHIVE_SERVICE_ADDR` is set AND the session has a `PAGEPOCKET_USER_ID` (resolved from the extension's stored API-key-to-user mapping)
- **THEN** the server MUST call `ArchiveService.IngestPage` over a mTLS gRPC channel with `user_id`, `url`, `title`, the merged `html_content`, the full list of uploaded `Asset { filename, content_type, data }`, and an `extension_job_id` equal to the session UUID
- **AND** on success, the session-status response MUST include a new `cloud_page_id` field in addition to the existing local `download_url`

#### Scenario: Cloud archiving disabled
- **WHEN** `ARCHIVE_SERVICE_ADDR` is unset or empty
- **THEN** the extension server MUST behave exactly as before: no gRPC call is attempted, and the session-status response MUST NOT include `cloud_page_id`

#### Scenario: Idempotent replay
- **WHEN** the extension server's cloud-push call is retried (e.g. after a transient failure and a re-finalization)
- **THEN** the `extension_job_id` MUST remain the session UUID across retries
- **AND** the archive service's idempotency guarantee MUST prevent duplicate cloud pages

#### Scenario: Cloud push failure does not break local download
- **WHEN** the gRPC call fails (unavailable, deadline-exceeded, or any non-OK status)
- **THEN** the local ZIP/HTML download MUST still be available via the existing `GET /api/v1/sessions/{id}/download` endpoint
- **AND** the session-status response MUST include `cloud_status: "failed"` with the gRPC status code so the extension can surface a non-blocking warning
- **AND** the server MAY retry the cloud push up to 3 times with exponential backoff before marking it failed

#### Scenario: mTLS required for outbound channel
- **WHEN** the extension server opens the gRPC channel to `ARCHIVE_SERVICE_ADDR`
- **THEN** it MUST use `grpc.ssl_channel_credentials(root_certificates, private_key, certificate_chain)` loaded from paths `ARCHIVE_CA_CERT`, `ARCHIVE_CLIENT_KEY`, `ARCHIVE_CLIENT_CERT`
- **AND** the server MUST refuse to start if `ARCHIVE_SERVICE_ADDR` is set but any of those three cert paths are missing or unreadable

### Requirement: Session-to-User Mapping
The extension server SHALL resolve an `X-API-Key` to a PagePocket `user_id` when cloud archiving is enabled, using the same user row that owns the session.

#### Scenario: API key mapped to user
- **WHEN** `ARCHIVE_SERVICE_ADDR` is set and a session is created with a valid `X-API-Key`
- **THEN** the server MUST record the owning `user_id` on the session at creation time (value retrieved from the local `users` table row matching the API key)
- **AND** this `user_id` MUST be the value sent in `IngestPageRequest.user_id` on finalization

#### Scenario: API key without mapped user
- **WHEN** cloud archiving is enabled and the API key resolves to a user row that has no linked `pagepocket_user_id`
- **THEN** the cloud push MUST be skipped for that session (behaves as if cloud archiving were disabled for this session only)
- **AND** the local download flow MUST continue to work unchanged
