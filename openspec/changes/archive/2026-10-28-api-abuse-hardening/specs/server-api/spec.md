## MODIFIED Requirements

### Requirement: Client Registration

The server SHALL provide a `POST /api/v1/auth/register` endpoint that allows extensions to register and obtain an API key automatically. The user never sees or manages API keys. Registration of an `extension_instance_id` that is already registered SHALL require proof of possession of that client's current API key: the proof-bearing re-registration returns the existing key and identity (re-unlock), while an ID-only re-registration is rejected — the instance ID alone SHALL never yield a key. First-time registration remains unauthenticated and rate-limited.

#### Scenario: Successful registration

- **WHEN** a client sends a POST request to `/api/v1/auth/register` with a unique client identifier (e.g., extension instance ID)
- **THEN** the server creates a new user record with a generated API key
- **AND** returns a 201 response with the API key

#### Scenario: Re-registration with existing client identifier requires proof of possession

- **WHEN** a client sends a POST request to `/api/v1/auth/register` with a client identifier that already exists, presenting that client's current API key as proof
- **THEN** the server returns the existing API key and identity with a 200 response
- **AND** does not create a duplicate user record

#### Scenario: Re-registration without proof is rejected

- **WHEN** a client sends a POST request to `/api/v1/auth/register` with a client identifier that already exists and no API-key proof
- **THEN** the server responds 409 with error `reauth_required` and a body that names the proof requirement
- **AND** no key material is returned and no new user record is created

#### Scenario: Re-registration with non-matching proof is rejected

- **WHEN** a client sends a POST request to `/api/v1/auth/register` for an already-registered identifier with an API key that does not verify against that client's stored credential
- **THEN** the server responds 401 with error `reauth_proof_invalid`
- **AND** no key material for the target identity is returned

#### Scenario: Fresh instance identifiers are unaffected

- **WHEN** a client registers with an instance identifier that has never been registered (e.g., a freshly rotated ID after a revoked key)
- **THEN** the request follows the first-registration path — unauthenticated, rate-limited, 201 with a new key
- **AND** no proof of possession is demanded

#### Scenario: Registration rate limiting

- **WHEN** a client sends more than 5 registration requests per minute from the same IP address
- **THEN** the server returns a 429 response with a retry-after header
- **AND** no new user records are created until the rate limit expires

### Requirement: Session Creation

The server SHALL provide a `POST /api/v1/sessions` endpoint that creates a new download session and returns a session ID. The session's cloud identity SHALL be sourced from the server-side client binding (see `cloud-push-authorization`): a client-supplied `pagepocketUserId` option is accepted only when it matches the authenticated client's stored binding, and is otherwise rejected with 403. Unbound clients get local-only sessions. The target URL SHALL be validated before any persistence (see `server-session-input-validation`), and creation SHALL count against the authenticated client's session-creation quotas (see `server-resource-guards`).

#### Scenario: Successful session creation

- **WHEN** a client sends a POST request to `/api/v1/sessions` with a valid API key, a `url` field, and an optional `options` object
- **THEN** the server creates a new session with status `scraping`
- **AND** returns a 201 response with the session ID, upload endpoint URLs, and status

#### Scenario: Session creation with singleFile option

- **WHEN** a client sends a POST request to `/api/v1/sessions` with `options.singleFile` set to `true`
- **THEN** the server creates a session flagged for single-file HTML output
- **AND** the session record stores the `singleFile` option for use during finalization

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

#### Scenario: Disallowed session URL is rejected

- **WHEN** a client sends a POST request to `/api/v1/sessions` whose `url` fails validation (non-http(s) scheme, or a private/loopback/link-local IP-literal target)
- **THEN** the server responds 400 with error `url_not_allowed`
- **AND** no session row or storage directory is created

#### Scenario: Session creation beyond the client's quota is rejected

- **WHEN** a client with an exhausted session-creation quota (active-session cap or rolling daily cap) sends a valid session-create request
- **THEN** the server responds 429 with error `session_limit_exceeded` identifying which limit fired
- **AND** no session is created

#### Scenario: Missing API key

- **WHEN** a client sends a POST request to `/api/v1/sessions` without an API key
- **THEN** the server returns a 401 response with an error message

#### Scenario: Invalid API key

- **WHEN** a client sends a POST request to `/api/v1/sessions` with an unrecognized API key
- **THEN** the server returns a 401 response with an error message
