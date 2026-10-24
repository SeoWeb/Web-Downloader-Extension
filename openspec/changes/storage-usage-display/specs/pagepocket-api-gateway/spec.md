## ADDED Requirements

### Requirement: Storage usage route

The gateway SHALL expose `GET /api/v1/archive/storage` as an authenticated route under the archive router. The route SHALL call the archive-service usage RPC with `request.state.user_id` and `request.state.plan` (set by the auth middleware from the validated JWT) and SHALL return `{used_bytes, storage_limit_bytes, plan, pages_this_month, page_limit_monthly, quota_reset_at}`. The route SHALL NOT query any database directly.

#### Scenario: Usage returned for the caller

- **WHEN** an authenticated client requests `GET /api/v1/archive/storage`
- **THEN** the gateway proxies to archive-service with the caller's user id and plan from the token
- **AND** returns 200 with the usage payload

#### Scenario: Unauthenticated access denied

- **WHEN** the route is called without a valid Bearer token
- **THEN** the auth middleware rejects with 401 before the handler runs
