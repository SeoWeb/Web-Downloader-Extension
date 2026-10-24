## Why

PagePocket enforces storage quotas server-side (free 500 MB, pro 10 GB) and already rejects uploads over quota with HTTP 402 — but the app shows users nothing about how much space they use or what consumes it. Users discover the limit only through a failed download. The data already exists (per-page `size_bytes` is stored and returned by the list endpoint; a transactionally-maintained `user_quotas.total_bytes` counter exists), so this is a visibility gap, not a data gap.

## What Changes

- New read-only endpoint `GET /api/v1/archive/storage` on the gateway, backed by an additive `GetStorageUsage` gRPC RPC on archive-service: returns `{used_bytes, storage_limit_bytes, plan, pages_this_month, page_limit_monthly, quota_reset_at}` for the authenticated user (plan from the JWT; limits from the server's `PLAN_LIMITS`).
- Web app sidebar gains a storage meter (bottom, under Collections): "X of Y used" + progress bar (amber ≥75%, red ≥90%/over) + plan badge (Free/Pro/Team).
- Every page card in the dashboard grid shows the page's storage size as a subtle badge (KB/MB/GB via a shared `formatBytes` util).
- Deleting a page immediately refreshes the meter (usage-query invalidation alongside the existing list invalidation).
- Display-only: no quota enforcement, warnings, or "storage full" flows in the web app (v1). Upload-path 402 behavior is unchanged.

## Capabilities

### New Capabilities

- `storage-usage-display`: client-facing storage-usage visibility — endpoint read semantics (counter trust, plan limits, zero-state), sidebar meter behavior, per-page size badges, byte formatting, and refresh-on-delete.

### Modified Capabilities

- `pagepocket-api-gateway`: new authenticated `GET /api/v1/archive/storage` route proxying the archive-service usage RPC.
- `pagepocket-archive-service`: new additive `GetStorageUsage` RPC reading `user_quotas` + `PLAN_LIMITS`.

## Impact

- **Backend (`pagepocket/services/`)**: `proto/archive.proto` (+ stub regen), `archive-service/servicer.py` (+ models reuse), `api-gateway/routers/archive.py`; tests for both services. No DB/schema changes, no existing behavior modified — fully additive.
- **Frontend (`pagepocket/frontend/`)**: new zod schema + client method, new `formatBytes` util, new `storage-meter.tsx` mounted in `sidebar.tsx`, `page-card.tsx`/`dashboard.tsx` size-badge + props threading, delete-mutation invalidation; vitest coverage. No i18n (web app is hardcoded English).
- **Deploy**: automatic via CI (`deploy-backend` + `deploy-frontend` jobs cover `pagepocket/**`); gateway and archive-service must land together (new RPC + its route). No monolith (`server/`) changes.
- **Out of scope (v1)**: quota enforcement/402 UI, pages-this-month display (field is returned but unused), counter drift reconciliation, extension-side display.
