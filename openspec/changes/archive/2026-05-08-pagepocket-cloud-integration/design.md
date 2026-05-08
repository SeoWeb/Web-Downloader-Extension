## Context

The WebsiteDownloader extension has two download pipelines:
1. **Local mode** (default): Scrapes page → processes resources → generates ZIP via `SplitZipGenerator` or `IndexedDBAdapter` → saves via `chrome.downloads.download()`
2. **Server mode** (build-time `VITE_SERVER_URL`): Scrapes page → uploads chunks/resources to Python microservice → server assembles ZIP → downloads from server URL

PagePocket is a separate SaaS backend (`pagepocket/`) with JWT auth, gRPC microservices, and Cloudflare R2 storage. It has no extension integration. The existing `ServerClient` uses API-key auth (auto-registration) which is incompatible with PagePocket's JWT user accounts.

The download pipeline entry point is `downloadResources()` in `src/background/download-core.ts`. It branches at `shouldUseServerMode()` to decide local vs server pipeline.

## Goals / Non-Goals

**Goals:**
- Allow extension users to toggle PagePocket cloud storage ON/OFF
- When ON: upload pages directly to PagePocket (no local file), using JWT user auth
- Reuse existing PagePocket backend (gRPC services) — only add one REST endpoint
- Keep existing local and server-mode pipelines completely unaffected

**Non-Goals:**
- Migrating the existing Python microservice server mode to PagePocket
- Offline cloud access or caching
- Collection/tag management from the extension (use the PagePocket web UI)
- Upload of linked pages (only the main page in cloud mode for v1)
- Sharing pages from the extension (use the web UI)

## Decisions

### 1. Separate client from ServerClient
**Decision:** Create a new `PagePocketClient` class in `src/background/pagepocket-client.ts`, completely independent of `ServerClient`.

**Rationale:** Different auth models (JWT Bearer vs X-API-Key), different API shapes (multipart upload vs session-based), different error handling (token refresh vs auto-registration). Sharing code would create coupling between unrelated systems.

**Alternative considered:** Extend ServerClient with a "mode" flag. Rejected because the auth flows are fundamentally different and mixing them increases complexity.

### 2. Cloud upload replaces local download entirely
**Decision:** When cloud mode is ON, skip ZIP creation and upload HTML + assets directly. No local file saved.

**Rationale:** User preference — cloud-only mode avoids duplicate storage and confusing "saved to both places" UX.

**Alternative considered:** Post-download upload (local ZIP + cloud copy). More resilient but adds complexity and confusion about where the page lives.

### 3. Branch in download-core.ts alongside existing server-mode branch
**Decision:** Add a `shouldUseCloudUpload()` check in `downloadResources()` that gates cloud-mode. Priority order: cloud-mode > server-mode. The server-mode pipeline runs when cloud is off (the former `shouldUseServerMode()` check was removed when server-mode became the default pipeline). Cloud mode takes precedence because it is an explicit user opt-in that replaces the download entirely.

**Rationale:** Server mode is now the default download pipeline (replacing local-only). Cloud mode is a runtime toggle that, when enabled, should override server-mode since the user explicitly chose cloud storage over local/server download.

### 4. Build-time feature flag via VITE_PAGEPOCKET_URL
**Decision:** Use `VITE_PAGEPOCKET_URL` env var at build time to enable PagePocket features. When not set, all cloud UI is hidden.

**Rationale:** Same pattern as existing `VITE_SERVER_URL`. Some extension builds won't have PagePocket backend available.

### 5. JWT tokens stored in chrome.storage.local as atomic object
**Decision:** Store `{ accessToken, refreshToken, expiresAt, user }` as a single JSON object under key `pagepocket_auth`.

**Rationale:** Atomic reads/writes prevent race conditions where access token is updated but refresh token isn't. Chrome storage API is async and doesn't support transactions — keeping everything under one key is the safest approach.

### 6. Multipart/form-data for ingest endpoint
**Decision:** The new REST endpoint accepts `multipart/form-data` with the HTML and assets as file uploads.

**Rationale:** Assets are binary blobs (images, PDFs) that don't encode well in JSON or protobuf-over-REST. Multipart is the standard for file uploads and works with `fetch()` + `FormData` in service workers.

## Risks / Trade-offs

**[Risk] Service worker timeout during large uploads** → The extension already has keepalive port management for long downloads. Cloud uploads will use the same pattern to prevent service worker kill during upload.

**[Risk] Cloud mode confuses users who expect a local file** → The UI clearly states "Saved to PagePocket" and shows a "View in PagePocket" link. No "Show in Folder" button appears in cloud mode.

**[Risk] Token theft from chrome.storage.local** → PagePocket tokens have short lifetimes (1 hour access, 30 day refresh with rotation). Storage is scoped to the extension. Same threat model as the existing `server_api_key` storage.

**[Risk] Large pages hitting multipart size limits** → The archive-service already handles page ingestion for large pages via its quota system. The extension's existing resource processing handles memory management. No additional chunking is needed for v1.

**[Trade-off] No offline support for cloud mode** → Users must be online to upload. The extension already requires network for server mode. This is acceptable for v1.
