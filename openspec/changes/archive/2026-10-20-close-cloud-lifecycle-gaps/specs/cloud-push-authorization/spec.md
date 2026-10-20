## ADDED Requirements

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
