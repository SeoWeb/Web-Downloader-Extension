## Why

The WebsiteDownloader Chrome extension saves pages locally (IndexedDB/JSZip ZIP archive) or to a self-hosted Python microservice (build-time `VITE_SERVER_URL`). The PagePocket SaaS backend at `pagepocket/` provides cloud storage with user accounts, JWT auth, search, collections, and sharing — but the extension has no connection to it. Users who want cloud archival currently have no way to use PagePocket from the extension.

## What Changes

- Add a "PagePocket Cloud Storage" toggle in the extension's Configuration panel (visible only when `VITE_PAGEPOCKET_URL` is set at build time)
- When toggled ON, require the user to register or log in with a PagePocket account (JWT-based, separate from the existing server-mode API-key auth)
- When cloud mode is active, replace the local ZIP download pipeline: scrape the page, then upload HTML + assets directly to PagePocket via the existing REST API (no local file saved)
- Add a REST endpoint `POST /api/v1/archive/pages/ingest` to the PagePocket api-gateway to accept page uploads from the extension (the `IngestPage` gRPC method exists but has no REST route)
- Show upload progress and completion status in the extension UI
- When toggled OFF, the extension works exactly as before (local download)

## Capabilities

### New Capabilities
- `extension-cloud-toggle`: Toggle in extension settings to enable/disable PagePocket cloud storage, persisted in chrome.storage.local
- `extension-cloud-auth`: Login/register UI in the extension sidepanel using PagePocket JWT auth (register, login, token refresh, logout)
- `extension-cloud-upload`: Upload pipeline that replaces local ZIP generation — scrapes page, packages HTML + assets, uploads to PagePocket via REST with progress tracking
- `pagepocket-ingest-rest`: REST endpoint on the api-gateway that accepts page uploads from the extension via multipart/form-data and routes to the archive-service IngestPage gRPC method

### Modified Capabilities
- `download-engine`: Branch point added — when cloud mode is ON, skip local ZIP creation and upload directly to PagePocket instead

## Impact

**Extension side:**
- New files: `pagepocket-client.ts`, `pagepocketStore.ts`, `pagepocket-mode.ts`, `authTypes.ts`, `PagePocketToggle.tsx`, `PagePocketAuth.tsx`, `CloudUploadStatus.tsx`
- Modified: `download-core.ts` (add cloud upload branch), `Filter.tsx` (add toggle), `sidepanel.tsx` (auth form conditional), `MainContent.tsx` (auth form rendering), `DownloadComplete.tsx` (cloud upload result), `DownloadStatus.tsx` (upload progress), `message.ts` (new actions)
- New env var: `VITE_PAGEPOCKET_URL` (build-time, separate from existing `VITE_SERVER_URL`)
- New i18n keys for cloud-related UI text

**Backend side (PagePocket):**
- Modified: `services/api-gateway/routers/archive.py` — add POST ingest endpoint
- No database changes, no proto changes — reuses existing `IngestPage` gRPC method

**No breaking changes** — all existing local and server-mode download flows remain unchanged when cloud toggle is OFF.
