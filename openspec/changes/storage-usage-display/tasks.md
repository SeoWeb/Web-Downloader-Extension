## 1. Backend — archive-service RPC

- [x] 1.1 Add `GetStorageUsage` to `pagepocket/proto/archive.proto`: request `{user_id, plan}`, response `{total_bytes, pages_this_month, quota_reset_at, storage_limit_bytes, page_limit_monthly, plan}` (match existing proto conventions); regenerate tracked stubs with the repo's proto tooling (never hand-edit `pagepocket/shared/proto_generated/`)
- [x] 1.2 Implement `GetStorageUsage` in `archive-service/servicer.py`: read-only `user_quotas` lookup (no `FOR UPDATE`, no rollover mutation — see design D4), zeros when the row is missing, limits from `PLAN_LIMITS` by requested plan
- [x] 1.3 Tests: row present → counters + plan limits; row missing → zeros + limits; repeated calls leave `user_quotas` unchanged

## 2. Backend — gateway route

- [x] 2.1 Add `GET /api/v1/archive/storage` to `api-gateway/routers/archive.py`: call the usage RPC with `request.state.user_id` / `request.state.plan`, return the response model; no direct DB access
- [x] 2.2 Tests: unauthenticated → 401 (middleware), authenticated → 200 payload with mocked gRPC

## 3. Frontend — data layer + formatter

- [x] 3.1 `src/lib/api/schemas/index.ts`: `StorageUsageSchema` (`used_bytes`, `storage_limit_bytes`, `plan`, `pages_this_month`, `page_limit_monthly`, `quota_reset_at`) + inferred type
- [x] 3.2 `src/lib/client-api.ts`: `getStorageUsage()` via `clientFetch` (zod-validated); server wrapper in `src/lib/api/archive.ts` only if an RSC pre-fetch is idiomatic
- [x] 3.3 New `formatBytes` util (e.g. `src/lib/format.ts`): 1024 base, B/KB/MB/GB, 1 decimal <10 else whole — single formatter for meter + badges (design D5)

## 4. Frontend — UI

- [x] 4.1 New `src/components/app/storage-meter.tsx`: react-query `qk("archive","storageUsage")`, staleTime ~60 s, enabled on `useUserId()`; "X of Y used" + progress bar (amber ≥75 %, red ≥90 %/over) + plan badge (Free/Pro/Team); quiet loading/error states
- [x] 4.2 Mount the meter at the bottom of `src/components/app/sidebar.tsx`
- [x] 4.3 `page-card.tsx` + `dashboard.tsx`: thread optional `size_bytes` into PageCard, render a subtle size badge in the meta row (absent when undefined)
- [x] 4.4 `dashboard.tsx` delete mutation `onSettled`: also invalidate `qk("archive","storageUsage")`

## 5. Verify & ship

- [x] 5.1 Frontend: vitest for `formatBytes`, meter render (mocked query, threshold colors, plan badges), card size badge; full suite + typecheck + build green
- [x] 5.2 Backend: archive-service + api-gateway test suites green
- [x] 5.3 Commit + push `main:pagepocket`; CI green; `deploy-backend` AND `deploy-frontend` jobs succeed (gateway + archive-service land together)
- [ ] 5.4 User verification at pagepocket.app: meter shows real usage (pro account → 10 GB limit), sizes on cards, delete drops the meter
