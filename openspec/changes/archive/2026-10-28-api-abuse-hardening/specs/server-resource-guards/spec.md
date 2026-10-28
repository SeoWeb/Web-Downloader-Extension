## ADDED Requirements

### Requirement: Per-client session-creation quotas

Session creation SHALL be capped per authenticated client by two config-backed counters, both evaluated before any session row or storage directory is created: an active-session cap (`max_active_sessions_per_client`, default 20) counting sessions in `scraping`, `uploading`, or `assembling` status, and a rolling creation cap (`max_sessions_per_client_per_day`, default 200) counting sessions created in the trailing 24 hours. A request that would exceed either cap SHALL be rejected with 429 error `session_limit_exceeded` carrying `limit_type` (`active_sessions` or `daily_creations`), the `limit` value, and a `retry_after` hint; the daily-creation rejection SHALL also emit an accurate `Retry-After` header. Quotas SHALL be plan-independent (uniform per key) in v1.

#### Scenario: Active-session cap rejects further creation

- **GIVEN** a client already holding `max_active_sessions_per_client` sessions in `scraping`/`uploading`/`assembling` status
- **WHEN** the client creates another session
- **THEN** the server responds 429 with error `session_limit_exceeded` and `limit_type: active_sessions`
- **AND** no session row or storage directory is created

#### Scenario: Completed sessions free active budget

- **GIVEN** a client at the active-session cap
- **WHEN** one of its sessions reaches a terminal status (`ready`, `failed`, `expired`) and the client creates a new session
- **THEN** the creation is accepted

#### Scenario: Daily creation cap rejects churn with an accurate Retry-After

- **GIVEN** a client that has created `max_sessions_per_client_per_day` sessions within the trailing 24 hours
- **WHEN** the client creates another session
- **THEN** the server responds 429 with error `session_limit_exceeded` and `limit_type: daily_creations`
- **AND** the `Retry-After` header and `retry_after` body value reflect the time until the oldest in-window creation ages out of the 24-hour window

#### Scenario: Quotas are independent per client

- **GIVEN** one client at its session-creation cap
- **WHEN** a different client creates a session
- **THEN** the other client's creation is accepted

### Requirement: Registration limiter covers every register outcome

Every `POST /api/v1/auth/register` request SHALL consume the per-IP registration bucket before any identity resolution — including requests that resolve via the instance-id dedup lookup, succeed as proof-of-possession re-unlocks, or are rejected with 409/401. The per-instance daily budget SHALL remain consumed only by fresh registrations. No additional rate-limiting machinery is introduced by this rule; it pins the existing coverage as a requirement so the proof-of-possession gate cannot be probed at unbounded volume.

#### Scenario: Rejected re-registration consumes the per-IP bucket

- **GIVEN** an already-registered instance identifier
- **WHEN** ID-only re-registration requests (rejected 409) arrive repeatedly from one IP beyond the per-IP registration limit
- **THEN** subsequent register requests from that IP are rejected 429 `rate_limit_exceeded`

#### Scenario: Proof-of-possession re-unlock consumes the per-IP bucket

- **GIVEN** an already-registered instance identifier and its correct API key
- **WHEN** proof-bearing re-unlock registrations arrive repeatedly from one IP beyond the per-IP registration limit
- **THEN** subsequent register requests from that IP are rejected 429 `rate_limit_exceeded`

#### Scenario: Instance guessing from one IP stays volume-bounded

- **WHEN** a single IP floods register requests with many distinct instance identifiers
- **THEN** the per-IP registration limiter bounds the request rate regardless of identifier novelty
- **AND** each unregistered identifier still yields only a fresh 201 client (never an existing identity's key)
