## ADDED Requirements

### Requirement: Server-side cloud identity binding
The monolith SHALL bind a PagePocket user to an authenticated API-key client through a server-side binding flow, and SHALL NOT trust a client-supplied `pagepocketUserId` session option as authorization. The binding SHALL be created only when the client proves both identities: a valid `X-API-Key` and a PagePocket access token verified against the Auth Service. The monolith SHALL store the verified `user_id` and the user's `plan` on the client record.

#### Scenario: Binding created from verified token
- **WHEN** a client sends `POST /api/v1/cloud/link` with a valid `X-API-Key` header and a body containing a PagePocket access token
- **THEN** the monolith verifies the token with `AuthService.Verify` over gRPC mTLS
- **AND** on `valid=true`, stores the returned `user_id` (and plan) as the client's cloud binding and returns success with the bound user id
- **AND** on `valid=false`, returns 401 and stores nothing

#### Scenario: Unauthenticated binding attempt rejected
- **WHEN** a request to the binding endpoint carries no API key or an unknown API key
- **THEN** the monolith returns 401 and no binding is created or modified

### Requirement: Session creation uses only the bound identity
When creating a session, the monolith SHALL source the cloud push identity exclusively from the server-side client binding. A client-supplied `pagepocketUserId` option SHALL be accepted only when it matches the stored binding; any other value SHALL be rejected.

#### Scenario: Client-sent id matching the binding is accepted
- **WHEN** a session is created with `options.pagepocketUserId` equal to the client's stored binding
- **THEN** the session proceeds with that cloud identity

#### Scenario: Client-sent id diverging from the binding is rejected
- **WHEN** a session is created with `options.pagepocketUserId` that differs from the client's stored binding
- **THEN** the monolith returns 403 and creates no session

#### Scenario: Unbound client cannot push to cloud
- **WHEN** a client with no cloud binding requests cloud-mode behavior (directly or via a supplied `pagepocketUserId`)
- **THEN** the session is created without a cloud binding and the assembly does NOT push to PagePocket
- **AND** the session status response reports the session as local-only (no `cloud_page_id`)

### Requirement: Cloud push carries the server-resolved identity and plan
The monolith's cloud push (`IngestPage`) SHALL fill `user_id` from the client's server-side binding and `plan` from the plan recorded at binding time (refreshed when the binding is re-verified). The push SHALL NOT omit the plan and SHALL NOT accept a plan from extension-supplied data.

#### Scenario: Pushed page is billed to the bound user's real plan
- **WHEN** the monolith pushes a finished page for a client bound to a `pro` user
- **THEN** the `IngestPageRequest` carries `user_id=<bound user>` and `plan="pro"`
- **AND** the archive service enforces `pro` quotas for the ingest

#### Scenario: Re-binding updates the plan
- **WHEN** a client re-runs the binding flow and the verified token now reports a different plan
- **THEN** subsequent pushes carry the new plan
