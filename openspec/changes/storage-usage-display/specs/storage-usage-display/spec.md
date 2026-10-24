## ADDED Requirements

### Requirement: Storage usage read semantics

The archive-service SHALL expose a read-only `GetStorageUsage` RPC that, for a given user, returns the user's `total_bytes` from `user_quotas`, the plan's storage and monthly page limits from `PLAN_LIMITS`, `pages_this_month`, `quota_reset_at`, and the plan name. A user with no `user_quotas` row SHALL yield zero usage with full plan limits. The read SHALL NOT take row locks or mutate quota state.

#### Scenario: Existing user with stored pages

- **WHEN** `GetStorageUsage` is called for a user whose `user_quotas` row has `total_bytes = 52428800`
- **THEN** the response carries `total_bytes = 52428800` and the limits for the user's plan

#### Scenario: User without a quota row

- **WHEN** `GetStorageUsage` is called for a user with no `user_quotas` row
- **THEN** usage is `0` and the response still carries the plan's full limits

#### Scenario: Read does not mutate

- **WHEN** `GetStorageUsage` is called repeatedly
- **THEN** the `user_quotas` row is unchanged (no rollover, no lock)

### Requirement: Storage usage endpoint

The gateway SHALL expose `GET /api/v1/archive/storage` for authenticated users, returning `{used_bytes, storage_limit_bytes, plan, pages_this_month, page_limit_monthly, quota_reset_at}` sourced from the archive-service usage RPC with the caller's identity and plan taken from the validated JWT. Unauthenticated requests SHALL be rejected with 401 like every other non-public route.

#### Scenario: Authenticated usage read

- **WHEN** a logged-in client sends `GET /api/v1/archive/storage` with a valid access token
- **THEN** the response contains the user's `used_bytes`, the plan's `storage_limit_bytes` (free: 500 MB, pro: 10 GB, team: 50 GB), the plan name, and the monthly counters

#### Scenario: Unauthenticated request rejected

- **WHEN** the endpoint is called without a valid access token
- **THEN** the gateway returns 401 and archive-service is not consulted

### Requirement: Sidebar storage meter

The logged-in web app SHALL display a storage meter at the bottom of the sidebar showing used vs limit (e.g. "50 MB of 500 MB used") via a shared byte formatter, a progress bar proportional to usage, and a plan badge (Free/Pro/Team). The progress bar SHALL turn amber at ≥75 % usage and red at ≥90 % or when over the limit. The meter SHALL load and fail quietly (skeleton or placeholder) without breaking the sidebar, and SHALL refresh when a page is deleted.

#### Scenario: Free user meter

- **WHEN** a free-plan user with 50 MB used views the app
- **THEN** the sidebar shows "50 MB of 500 MB used" with a "Free" badge and a ~10 % fill

#### Scenario: Pro user meter

- **WHEN** a pro-plan user with 700 MB used views the app
- **THEN** the meter's limit reads 10 GB and the badge reads "Pro"

#### Scenario: Near-limit coloring

- **WHEN** usage crosses 75 % of the limit
- **THEN** the progress bar renders amber; at ≥90 % (or over the limit) it renders red

#### Scenario: Meter reflects deletion

- **WHEN** the user deletes a page from the dashboard
- **THEN** the meter refetches and shows the reduced usage without a manual reload

### Requirement: Per-page storage size on cards

Each page card in the dashboard SHALL display the page's `size_bytes` as a human-readable badge (e.g. "2.4 MB") using the shared byte formatter. Cards without size data SHALL render without the badge.

#### Scenario: Card shows its size

- **WHEN** the dashboard renders a page whose list response carries `size_bytes = 2516582`
- **THEN** the card shows a badge reading "2.4 MB"

#### Scenario: Missing size tolerated

- **WHEN** a page item has no `size_bytes`
- **THEN** the card renders normally with no size badge

### Requirement: Byte formatting consistency

The app SHALL use a single shared `formatBytes` utility (1024 base; B/KB/MB/GB; one decimal below 10, whole numbers at or above) for all storage values — meter usage, meter limit, and card badges — so equivalent values render identically everywhere.

#### Scenario: Consistent rendering

- **WHEN** the same byte value is rendered by the meter and a card badge
- **THEN** both produce identical strings
