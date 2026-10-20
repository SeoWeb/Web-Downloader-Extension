## Why

PagePocket promises "Local ZIP Export" on the features page and in the Chrome Web Store listing, but a page saved to the cloud has no downloadable artifact anywhere: the dashboard viewer offers only Share/Delete, and the extension monolith's `/download` endpoint only serves ephemeral session-local ZIPs (cloud pushes get `zip_path = None`). Users whose work depends on pages outliving even PagePocket have no exit path — an anti-lock-in feature competitors advertise and professionals expect.

The storage layout already does the hard part: every archived page lives under one R2 prefix (`{user_id}/{page_id}/`) with `index.html` referencing `assets/…` via relative paths, so a ZIP of that prefix is offline-renderable as-is.

## What Changes

- **Archive service**: new streaming `ExportPage` gRPC — lists objects under the page's R2 prefix (`ListObjectsV2`), assembles a zip64 ZIP (spooled to disk past a RAM threshold), and streams it back in bounded chunks. No manifest or backfill needed; works for **all existing pages**.
- **API gateway**: new authenticated route `GET /api/v1/archive/pages/{page_id}/zip` — streams the ZIP to the client with `Content-Disposition: attachment; filename="<page title>.zip"` (title from existing page metadata, sanitized; ASCII fallback).
- **Frontend viewer**: Download button in the page viewer toolbar (beside Share/Delete) with the `d` hotkey and an honest tooltip ("Static snapshot — scripts not included").
- **Frontend dashboard**: "Download" entry in the per-page card dropdown menu.
- **Docs/changelog**: getting-started doc gains the download flow; a changelog entry announces it.

**Explicitly out of scope (v1)**: share-page (`/s/[token]`) visitor downloads (public abuse surface + 20/min/IP rate class), single-file inlined-HTML export, collection batch export, extension "download from cloud" flow.

## Capabilities

### Modified Capabilities

- `pagepocket-archive-service`: adds a Page ZIP Export requirement (streaming RPC over the R2 prefix).
- `pagepocket-api-gateway`: adds a Page Export Route requirement (authenticated streaming endpoint).
- `pagepocket-frontend-page-viewer`: adds a Download Action requirement.
- `pagepocket-frontend-dashboard`: adds a Card Download Action requirement.

## Impact

- **Code**: `pagepocket/proto/**` (+ regenerated stubs), `pagepocket/services/archive-service/**` (servicer + tests), `pagepocket/services/api-gateway/**` (router + tests), `pagepocket/frontend/src/components/app/**` (viewer shell + card/dashboard + tests). No DB migrations, no extension (`src/**`) changes, no BFF proxy changes (route is inside the existing allow-list and streams through).
- **Constraints honored**: Bearer auth via existing `AuthMiddleware`; 600/min/user rate class already applies; no presigned URLs (platform decision D4); per-page size ceiling ~256 MB bounds the ZIP; scripts-stripped nature of archives stated in UI copy.
- **Deploy**: backend changes ship via the manual monolith procedure (runbook §3: host fetch + `docker compose build` + `up -d`); frontend via `deploy-frontend`. Both only on explicit user order.
