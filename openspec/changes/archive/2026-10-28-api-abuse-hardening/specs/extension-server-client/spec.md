## ADDED Requirements

### Requirement: Proof-of-possession registration recovery

When the server rejects a registration with 409 `reauth_required` (the stored instance identifier is already registered and no proof of possession was presented), the extension SHALL recover by rotating to a fresh instance identifier (`rotateInstanceId`, persisted, single-flight via the registration mutex) and completing registration as a new client — the same recovery semantics as the post-401 fresh-instance path. When the extension does hold an API key at registration time, it SHALL send it as the `X-API-Key` proof so the registration can re-unlock the same identity. Recovery failures surface as `AuthenticationError` instead of looping.

#### Scenario: 409 reauth_required triggers fresh-instance registration

- **GIVEN** the extension holds a stored instance identifier whose server-side client exists, and no API key
- **WHEN** the registration attempt is rejected with 409 `reauth_required`
- **THEN** the extension rotates to a fresh instance identifier and registers as a new client within the same single-flight registration
- **AND** the resulting key is stored and used for subsequent calls

#### Scenario: Held key is sent as proof and re-unlocks the identity

- **GIVEN** the extension holds an API key at registration time
- **WHEN** it registers with its stored instance identifier
- **THEN** the request carries the key as `X-API-Key` proof
- **AND** a 200 re-unlock response keeps the existing identity and key

#### Scenario: Recovery failure terminates instead of looping

- **WHEN** fresh-instance registration after a 409 `reauth_required` also fails permanently
- **THEN** the extension throws an `AuthenticationError`
- **AND** no unbounded registration retry loop is entered

#### Scenario: New session-create error codes do not strand the caller

- **WHEN** `createSession` receives 400 `url_not_allowed` or 429 `session_limit_exceeded`
- **THEN** the error surfaces to the download pipeline as a terminal (non-retried) failure carrying the server's message
- **AND** no automatic retry loop consumes the daily creation budget
