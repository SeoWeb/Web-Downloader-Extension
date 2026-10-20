# Cloud Push Authorization Specification

## Purpose

Server-side authorization of cloud pushes: the authenticated binding of a PagePocket user to an API-key client, session identity sourced exclusively from that binding, the plan resolved server-side on every push, and disambiguated 401 causes on the binding endpoint.

## Requirements

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

### Requirement: 401 disambiguation contract on the binding endpoint

A 401 from the binding endpoint SHALL discriminate its two distinct causes via `detail.error` so that clients (the extension) can react correctly instead of guessing: `detail.error == "invalid_pagepocket_token"` means the request's API key was recognized but the PagePocket access token failed verification (the user's PagePocket login is bad — re-registering the instance must not be attempted), while `detail.error == "invalid_api_key"` means the monolith does not recognize the request's API key (the server-side key was revoked or the instance is unknown — the extension re-registers once as a fresh instance and retries the link a single time).

#### Scenario: Bad PagePocket token reported as invalid_pagepocket_token

- **WHEN** the request carries a recognized API key but the PagePocket access token fails verification
- **THEN** the response is 401 with `detail.error == "invalid_pagepocket_token"`
- **AND** no binding is created or modified

#### Scenario: Revoked or unknown API key reported as invalid_api_key

- **WHEN** the request carries no API key, an unknown API key, or one revoked server-side
- **THEN** the response is 401 with `detail.error == "invalid_api_key"`
- **AND** no binding is created or modified

#### Scenario: Extension reacts differently to each code

- **WHEN** the extension receives a 401 from the binding endpoint
- **THEN** on `invalid_pagepocket_token` it does NOT re-register the instance (the PagePocket token is the problem; the user must re-login instead)
- **AND** on `invalid_api_key` it re-registers once as a fresh instance and retries the link exactly once, surfacing an error if that single retry also fails

### Requirement: Cloud identity unbinding on logout

The monolith SHALL expose `DELETE /api/v1/cloud/link`, authenticated by the same `X-API-Key` client identity as the binding flow, that clears the client's cloud binding (`pagepocket_user_id`, `pagepocket_plan`, `pagepocket_linked_at`) while leaving the client's API key and authentication metadata intact, so the client identity survives a PagePocket logout. The endpoint SHALL be idempotent: unbinding an already-unbound client SHALL still return success. The extension SHALL call this endpoint when the user logs out of PagePocket and SHALL treat a failed unbind call as non-blocking — logout SHALL always complete.

#### Scenario: Unbind clears the binding but keeps the client

- **WHEN** a client sends `DELETE /api/v1/cloud/link` with a valid `X-API-Key` for a bound client
- **THEN** the monolith clears `pagepocket_user_id`, `pagepocket_plan`, and `pagepocket_linked_at` and returns HTTP 200 with `{"bound": false, "api_version": "v1"}`
- **AND** the client row itself (API key, `last_auth_at`) remains valid and able to authenticate subsequent requests

#### Scenario: Unbind is idempotent

- **WHEN** `DELETE /api/v1/cloud/link` is sent for a client whose binding was already cleared
- **THEN** the monolith returns HTTP 200 with `{"bound": false, "api_version": "v1"}` (never 404 or 409)

#### Scenario: Unauthenticated unbind rejected

- **WHEN** the request carries no API key or an unknown API key
- **THEN** the monolith returns 401 and no client row is modified

#### Scenario: Extension logout unbinds without blocking

- **WHEN** the user logs out of PagePocket in the extension
- **THEN** the extension calls `DELETE /api/v1/cloud/link` and, on success, clears its stored `pagepocket_cloud_binding` session state
- **AND** a network or server failure is logged and skipped — logout completes and the local auth state is cleared regardless
