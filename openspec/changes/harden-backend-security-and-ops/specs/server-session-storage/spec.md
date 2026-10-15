## MODIFIED Requirements

### Requirement: Client Isolation via API Key
The server SHALL isolate sessions and data between different registered clients (API keys). The cloud binding (bound PagePocket user and plan, see `cloud-push-authorization`) SHALL be stored on the client record — never on the session as client-supplied data — so that session isolation and cloud identity are derived from the same authenticated root.

#### Scenario: Client can only access own sessions
- **WHEN** a client queries sessions or downloads with their API key
- **THEN** only sessions created with that API key are returned or accessible

#### Scenario: Cross-client access denied
- **WHEN** a client attempts to access a session created by a different API key
- **THEN** the server returns a 403 response

#### Scenario: Cloud identity lives on the client, not the request
- **WHEN** any session of a client resolves its cloud push identity
- **THEN** it uses the binding stored on the client record at link time
- **AND** no other client (or an unauthenticated caller) can read, set, or impersonate that binding via session options
