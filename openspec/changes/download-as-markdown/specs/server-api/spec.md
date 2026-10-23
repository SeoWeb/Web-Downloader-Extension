## MODIFIED Requirements

### Requirement: Session Creation

The server SHALL provide a `POST /api/v1/sessions` endpoint that creates a new download session and returns a session ID. The session's cloud identity SHALL be sourced from the server-side client binding (see `cloud-push-authorization`): a client-supplied `pagepocketUserId` option is accepted only when it matches the authenticated client's stored binding, and is otherwise rejected with 403. Unbound clients get local-only sessions.

#### Scenario: Successful session creation

- **WHEN** a client sends a POST request to `/api/v1/sessions` with a valid API key, a `url` field, and an optional `options` object
- **THEN** the server creates a new session with status `scraping`
- **AND** returns a 201 response with the session ID, upload endpoint URLs, and status

#### Scenario: Session creation with singleFile option

- **WHEN** a client sends a POST request to `/api/v1/sessions` with `options.singleFile` set to `true`
- **THEN** the server creates a session flagged for single-file HTML output
- **AND** the session record stores the `singleFile` option for use during finalization

#### Scenario: Session creation with markdown option

- **WHEN** a client sends a POST request to `/api/v1/sessions` with `options.downloadContentAsMarkdown` set to `true`
- **THEN** the server creates a session flagged for markdown export
- **AND** the session record stores the `downloadContentAsMarkdown` option for use during assembly
- **AND** when the option is absent or `false`, no markdown export is flagged

#### Scenario: Session creation with retention period

- **WHEN** a client sends a POST request to `/api/v1/sessions` with `options.retentionDays` set to a positive integer
- **THEN** the server sets the session's `expires_at` to the specified number of days from creation
- **AND** the value is clamped to a server-configured range (e.g., 1-30 days)
- **AND** if not specified, the default retention is 1 day

#### Scenario: Client-sent pagepocketUserId must match the binding

- **WHEN** a client sends `options.pagepocketUserId` equal to its stored cloud binding
- **THEN** the session is created with that cloud identity

#### Scenario: Forged pagepocketUserId is rejected

- **WHEN** a client sends `options.pagepocketUserId` with another user's ID (or any value while unbound)
- **THEN** the server returns 403 and creates no session
- **AND** finished assemblies of that foreign user's sessions can never be targeted

#### Scenario: Missing API key

- **WHEN** a client sends a POST request to `/api/v1/sessions` without an API key
- **THEN** the server returns a 401 response with an error message

#### Scenario: Invalid API key

- **WHEN** a client sends a POST request to `/api/v1/sessions` with an unrecognized API key
- **THEN** the server returns a 401 response with an error message
