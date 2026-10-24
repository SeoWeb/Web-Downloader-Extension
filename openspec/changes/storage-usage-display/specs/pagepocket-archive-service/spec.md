## ADDED Requirements

### Requirement: Storage usage RPC

The archive-service SHALL implement a `GetStorageUsage` RPC that returns the caller's `user_quotas.total_bytes`, `pages_this_month`, and `quota_reset_at`, together with the storage and monthly page limits for the requested plan from `PLAN_LIMITS` (free: 500 MB / 50 pages, pro: 10 GB, team: 50 GB) and the plan name. Missing quota rows SHALL yield zero usage. The RPC SHALL be read-only: no locks, no rollover mutation, no state changes.

#### Scenario: Usage served from the counter

- **WHEN** `GetStorageUsage` runs for a user with a `user_quotas` row
- **THEN** the response reports that row's counters and the plan's limits

#### Scenario: Missing row defaults

- **WHEN** `GetStorageUsage` runs for a user with no quota row
- **THEN** usage counters are zero and limits reflect the requested plan
