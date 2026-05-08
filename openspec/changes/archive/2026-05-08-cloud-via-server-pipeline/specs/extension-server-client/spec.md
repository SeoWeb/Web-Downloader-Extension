## ADDED Requirements

### Requirement: PagePocket user ID in session options
The `SessionOptions` interface SHALL accept an optional `pagepocketUserId` field. When set, the extension includes it in the session creation request body under `options`.

#### Scenario: Create session with PagePocket user ID
- **WHEN** `createSession(url, { singleFile, retentionDays, pagepocketUserId })` is called with a non-null `pagepocketUserId`
- **THEN** the POST request body SHALL include `options.pagepocketUserId` alongside existing options
- **AND** the server response is unchanged

#### Scenario: Create session without PagePocket user ID
- **WHEN** `createSession(url, { singleFile, retentionDays })` is called without `pagepocketUserId`
- **THEN** the POST request body SHALL NOT include `pagepocketUserId` in options
- **AND** existing behavior is preserved

### Requirement: Cloud status fields in session status response
The `SessionStatusResponse` interface SHALL include `cloud_status`, `cloud_page_id`, and `cloud_error` fields matching the server response.

#### Scenario: Status response with cloud fields
- **WHEN** `getSessionStatus(sessionId)` is called for a session that has cloud push data
- **THEN** the response SHALL include `cloud_status` (null | "pending" | "success" | "failed"), `cloud_page_id` (null | UUID string), and `cloud_error` (null | error message)

#### Scenario: Status response without cloud fields
- **WHEN** `getSessionStatus(sessionId)` is called for a non-cloud session
- **THEN** `cloud_status`, `cloud_page_id`, and `cloud_error` SHALL be `null`
