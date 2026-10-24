## Context

The PagePocket web app (Next.js 16, react-query v5, zod, Tailwind — `pagepocket/frontend/`) gives users zero feedback on cloud storage. The backend already maintains everything needed: `archive_db.pages.size_bytes` (set at ingest, returned by list/get endpoints), and `archive_db.user_quotas.total_bytes` — a counter incremented transactionally on ingest (`archive-service/quota.py:77-123`) and decremented on delete (`servicer.py:791-800`). Plan limits are hardcoded in `PLAN_LIMITS` (`archive-service/models.py:57-61`): free 500 MB + 50 pages/mo, pro 10 GB, team 50 GB. JWTs carry `plan`; the gateway auth middleware sets `request.state.user_id` / `request.state.plan`.

What does not exist: any read path for usage. The gateway has **no DB access** — everything goes through gRPC — and archive.proto has no quota-read RPC (only the `RESOURCE_EXHAUSTED` error path with `exhausted:quota|` / `exhausted:size|` markers → HTTP 402/413). The frontend contract already declares `PageResponseSchema.size_bytes` (optional) but never renders it, and maps 402 to an unused `QuotaExceededError`.

User decisions: meter in the **sidebar**; per-page size on **cards only**; **display-only** (no enforcement UI).

## Goals / Non-Goals

**Goals:**

- One always-visible meter: "X of Y used", progress bar with threshold colors, plan badge.
- Per-page sizes on every card so the user can decide what to delete.
- Meter updates immediately on delete.
- Fully additive backend — zero changes to existing endpoints or behavior.

**Non-Goals:**

- Quota enforcement or 402/`QuotaExceededError` handling in the web app.
- Pages-this-month display in the UI (response carries the field for future use).
- Counter drift reconciliation (`SUM(pages.size_bytes)` repair) — parked.
- Extension/sidepanel display; per-asset breakdowns; i18n (web app is English-only today).

## Decisions

- **D1 — Read path: new additive RPC + REST route.** `GetStorageUsage(user_id)` on `ArchiveService` (proto + regenerated tracked stubs), exposed as `GET /api/v1/archive/storage` in `api-gateway/routers/archive.py`. Alternatives rejected: direct DB access from the gateway (violates the service's no-DB design); a `/me`-style endpoint on auth-service (usage lives in archive-service, and plan is already in the JWT).
- **D2 — Trust the counter.** `used_bytes` comes from `user_quotas.total_bytes` (transactionally maintained on ingest and delete). No `SUM()` reconciliation in the read path. Missing row → zeros with the plan's limits (fresh user).
- **D3 — Plan source: JWT via middleware.** The gateway passes `request.state.plan` (authoritative, from the token) into the RPC request; archive-service maps it through `PLAN_LIMITS` and echoes limits back. Single source of truth, no extra auth-service call.
- **D4 — Read-only quota access.** The servicer reads `user_quotas` without the `FOR UPDATE` lock used by reserve/confirm (`quota.py`) — this is a display read; no monthly-rollover mutation on read (rollover remains an ingest-time concern).
- **D5 — Formatting: one `formatBytes` util.** 1024 base; units B/KB/MB/GB; 1 decimal below 10, integers above (e.g. "2.4 MB", "512 MB", "10 GB"). Used by meter and card badges alike so limits and sizes render consistently.
- **D6 — Meter behavior.** react-query `useQuery` keyed `qk("archive","storageUsage")`, `enabled` on `useUserId()`, staleTime 60 s (plus default refetch-on-focus). Mounted at the bottom of `sidebar.tsx`. Load/error render quietly (skeleton/dash — never breaks the sidebar). Progress fill: normal → amber ≥75 % → red ≥90 % or over-limit.
- **D7 — Card badge + live meter.** `PageCard` gains optional `size_bytes` (already in the API contract); dashboard threads it through; badge renders in the card meta row. Delete mutation's `onSettled` additionally invalidates the storage key so the meter drops in the same refetch cycle that restores the list.
- **D8 — Deploy: CI-automatic, atomic pair.** `pagepocket/**` triggers `deploy-backend`/`deploy-frontend`. Gateway route and archive-service RPC must merge/deploy together (route depends on RPC); one commit ships both. No monolith rebuild — `server/` untouched.

## Risks / Trade-offs

- [Counter drift (manual DB edits, historical bugs) shows wrong totals] → Accepted: counter is transactionally maintained today; reconciliation endpoint parked as future work.
- [size_bytes is ingest-time raw bytes (pre-sanitisation, excludes R2 thumbnail)] → Close enough for "what should I delete" guidance; documented in the spec rather than recomputed.
- [Proto regen churn (tracked generated stubs)] → Regenerate with the repo's tooling target, never hand-edit stubs; diff limited to the new RPC.
- [Extra sidebar query on every app load] → One tiny RPC (single-row read) with 60 s staleTime; negligible.
- [Gateway + archive-service deploy skew] → Both deploy in the same `deploy-backend` job from the same commit; route is new so no old-client breakage either way.

## Migration Plan

1. Merge everything in one commit on `main` → push `pagepocket`.
2. CI green; `deploy-backend` (gateway + archive-service) and `deploy-frontend` deploy automatically.
3. Verify logged-in: meter shows real usage; pro account shows 10 GB limit; delete drops the meter.
4. Rollback: revert commit — feature is purely additive; nothing persists, no migrations.

## Open Questions

- None blocking. (Parked: pages-this-month UI, 402 full-storage dialog, drift repair, "Team" marketing surface.)
