## 1. Python Microservice - Project Scaffold

- [x] 1.1 Create `server/` directory with FastAPI project structure (`app/`, `app/api/`, `app/api/routes/`, `app/models/`, `app/services/`, `app/db/`)
- [x] 1.2 Create `requirements.txt` with FastAPI, uvicorn, SQLAlchemy, aiomysql, lxml, BeautifulSoup4, python-multipart, pydantic-settings, alembic (for DB migrations)
- [x] 1.3 Create `app/config.py` with Pydantic settings: server host/port, MySQL connection string, storage root path, max session size (default 500MB), default retention days (7), CORS allowed origins
- [x] 1.4 Create `app/main.py` with FastAPI app initialization, CORS middleware (allow `chrome-extension://` origins), API router mounting, startup/shutdown events
- [x] 1.5 Create `Dockerfile` and `docker-compose.yml` for deployment (including MySQL 8.0+ container with utf8mb4)
- [x] 1.6 Verify: server starts with `uvicorn app.main:app` and `/docs` endpoint is accessible

## 2. Python Microservice - Database Models

- [x] 2.1 Create `app/db/database.py` with async SQLAlchemy engine (aiomysql), session factory, and `init_db()` function that calls `alembic upgrade head` on startup (Alembic is the sole schema management tool; `create_all()` is NOT used alongside Alembic)
- [x] 2.2 Create `app/models/session.py` with Session model (id UUIDv4, user_id, url, status, options JSON column, html_chunks, resources_discovered, resources_received, total_size, created_at, updated_at, finalized_at, expires_at, zip_path, filename_map JSON column)
- [x] 2.3 Create `app/models/resource.py` with Resource model (id UUIDv4, session_id FK, original_url, local_path, storage_path, content_type, size, uploaded_at)
- [x] 2.4 Create database indexes on session.client_id, session.status, session.expires_at, resource.session_id, and resource.original_url
- [x] 2.5 Configure InnoDB engine, utf8mb4 character set, and row-level locking
- [x] 2.6 Verify: database tables are created via Alembic migration with correct columns, types, and indexes

## 3. Python Microservice - Session API

- [x] 3.1 Create `app/api/dependencies.py` with API key authentication dependency (X-API-Key header validation, auto-registration endpoint)
- [x] 3.2 Create `app/api/routes/auth.py` with `POST /api/v1/auth/register` (register extension client, return API key) with rate limiting (5 requests/minute per IP)
- [x] 3.3 Create `app/api/routes/health.py` with `GET /api/v1/health` (return server status, version, MySQL connectivity, and storage capacity info, no auth required)
- [x] 3.4 Create `app/api/routes/sessions.py` with `POST /api/v1/sessions` (create session with optional `options` object including `singleFile` and `retentionDays` (clamped 1-30), return session ID)
- [x] 3.5 Add `GET /api/v1/sessions` (list sessions for authenticated user with pagination)
- [x] 3.6 Add `GET /api/v1/sessions/{id}/status` (return session status, assembly phase, progress, download URL)
- [x] 3.7 Add `DELETE /api/v1/sessions/{id}` (cancel/delete session and files)
- [x] 3.8 Create `app/api/routes/html.py` with `POST /api/v1/sessions/{id}/html` (upload HTML chunk with `scrollIndex`, `pageType`, `pageUrl` fields and deduplication; store in subdirectories by pageUrl hash)
- [x] 3.9 Create `app/api/routes/resources.py` with `POST /api/v1/sessions/{id}/resources` (multipart resource upload with `Content-Encoding: gzip` support, only for text-based MIME types) and `POST /api/v1/sessions/{id}/filename-map` (upload or merge filename map)
- [x] 3.10 Create `app/api/routes/download.py` with `GET /api/v1/sessions/{id}/download` (serve ZIP with HTTP range request support for resumable downloads; serve single HTML file **without** range support — range requests are unnecessary for HTML output and add implementation complexity with no user benefit)
- [x] 3.11 Add `POST /api/v1/sessions/{id}/scrape-complete` endpoint (transition session from `scraping` to `uploading`, reject if not in `scraping` status)
- [x] 3.12 Add `POST /api/v1/sessions/{id}/content` endpoint (upload text content for `content.txt` inclusion in ZIP)
- [x] 3.13 Add `POST /api/v1/sessions/{id}/finalize` endpoint (only accepted in `uploading` status; set status to assembling, trigger pipeline, support `singleFile` option from session; reject if in `scraping` status with 409)
- [x] 3.14 Add rate limiting on resource uploads (600 requests/minute per session using token bucket)
- [x] 3.15 Verify: full session CRUD cycle works via curl/httpie (create, register, upload HTML, scrape-complete, upload resource, upload content, finalize, download)

## 4. Python Microservice - HTML Merge Service

- [x] 4.1 Create `app/services/html_merger.py` with skeleton-and-chunks merge logic (port of `merge-html.ts` + `HtmlAssembler.ts`)
- [x] 4.2 Implement first-chunk skeleton initialization with insertion point detection (`</body>`)
- [x] 4.3 Implement chunk deduplication by content hash AND scrollIndex (same hash + different scrollIndex is NOT a duplicate)
- [x] 4.4 Implement full merge on finalization: insert all chunks before `</body>` in skeleton
- [x] 4.5 Implement safe merge fallback for complex HTML (body-content concatenation with truncation)
- [x] 4.6 Implement HTML complexity analysis (element count > 100K, nesting > 50 levels, large tables > 5K rows)
- [x] 4.7 Implement merged HTML validation (well-formedness check)
- [x] 4.8 Implement linked page merge: separate chunk storage and merge per `pageUrl` for linked page HTML
- [x] 4.9 Verify: merge produces same output as client-side for test HTML documents
- [x] 4.10 Verify: linked page merge produces correct output stored in pages/ directory

## 5. Python Microservice - HTML Converter Service

- [x] 5.1 Create `app/services/html_converter.py` with image URL conversion using filename map (port of `image-converter.ts`)
- [x] 5.2 Implement lazy-load attribute conversion (data-src, data-lazy-src, etc.)
- [x] 5.3 Implement srcset parsing and conversion
- [x] 5.4 Implement inline style background-image conversion
- [x] 5.5 Implement script URL conversion (port of `script-converter.ts`)
- [x] 5.6 Implement stylesheet URL conversion (port of `stylesheet-converter.ts`)
- [x] 5.7 Implement link URL conversion for documents, HTML pages, external links (port of `link-converter.ts`)
- [x] 5.8 Implement object element conversion (port of `object-converter.ts`)
- [x] 5.9 Implement linked page HTML conversion with `../` path prefix for pages directory
- [x] 5.10 Implement CSS file URL conversion: rewrite `url()` references in standalone CSS files (port of `convertBackgroundImageUrlsToRelative` from `css.ts`), using `../images/` prefix for image references
- [x] 5.11 Verify: converter produces correct relative paths for a test HTML document with all resource types
- [x] 5.12 Verify: CSS file URL conversion produces correct `../images/` references
- [x] 5.13 Verify: linked page conversion uses `../` prefix correctly for all resource types

## 6. Python Microservice - ZIP Assembly Service

- [x] 6.1 Create `app/services/zip_assembler.py` with ZIP creation using DEFLATE compression level 6
- [x] 6.2 Implement merged HTML as `index.html`, resources at their designated paths (`images/`, `styles/`, `scripts/`, `fonts/`, `documents/`), linked pages in `pages/` directory
- [x] 6.3 Implement `content.txt` inclusion from content uploaded via `POST /api/v1/sessions/{id}/content` endpoint (skip if no content was uploaded)
- [x] 6.4 Implement safe ZIP filename generation from URL (hostname + path + timestamp, max 200 chars), and sanitize all client-provided file paths to prevent path traversal outside the ZIP directory
- [x] 6.5 Implement single-file HTML mode: read resources from disk, inline all CSS/JS/images/fonts as base64 data URIs (as specified in server-html-converter), ignore linked pages, escape `--` in `content.txt` before injecting as HTML comment, output `.html` instead of `.zip`. **Crucially, perform string assembly streamingly or using a generator/string-builder to prevent server RAM spikes from massive base64 strings.**
- [x] 6.6 Implement assembly error handling (missing resources are skipped with warning, unrecoverable errors set session to failed)
- [x] 6.7 Implement assembly progress updates: update `session.assembly_phase` and `session.assembly_progress_pct` in the DB after each major step
- [x] 6.8 Verify: ZIP assembly produces valid ZIP with correct file structure and paths (including fonts/, content.txt)
- [x] 6.9 Verify: single-file mode produces valid HTML with inlined resources

## 7. Python Microservice - Session Lifecycle and Cleanup

- [x] 7.1 Create `app/services/session_manager.py` with session lifecycle management (scraping → uploading → assembling → ready/failed)
- [x] 7.2 Implement scrape-complete transition: `scraping` → `uploading` on `POST /scrape-complete`
- [x] 7.3 Implement finalization validation: reject finalize if session is not in `uploading` status
- [x] 7.3a Touch `updated_at` on **every** HTML chunk upload and resource upload (not only on status transitions). This prevents the 30-minute stale-session cleanup (task 7.6) from falsely expiring an active session that is uploading many small resources. (S3 fix.)
- [x] 7.4 Implement session auto-expiry (default 7 days, configurable retentionDays on session creation)
- [x] 7.5 Create `app/services/cleanup.py` with periodic cleanup job (runs every hour, removes expired sessions and files)
- [x] 7.6 Implement startup cleanup: (a) mark stale sessions in `scraping`/`uploading` status (last updated >30 min ago) as `failed`; (b) mark `assembling` sessions as `failed`; (c) then remove expired sessions
- [x] 7.7 Implement file storage management: create session directories, store resources, store ZIPs
- [x] 7.8 Implement client isolation: all queries filter by client_id (from registration)
- [x] 7.9 Implement orphaned API key cleanup: delete client records with no sessions and age > 30 days
- [x] 7.10 Implement session size tracking: track total_size on session record, reject uploads exceeding MAX_SESSION_SIZE_MB (default 500MB)
- [x] 7.11 Verify: sessions auto-expire after retention period, cleanup removes files from disk
- [x] 7.12 Verify: orphaned API keys are cleaned up after 30 days of inactivity
- [x] 7.13 Verify: stale sessions are marked as failed on server restart
- [x] 7.14 Verify: session size limits are enforced

## 8. Extension - Server Client Module

- [x] 8.1 Create `src/background/server-client.ts` with `ServerClient` class (reads server URL from `import.meta.env.VITE_SERVER_URL`, auto-registers on first use)
- [x] 8.2 Implement `createSession(url, options?)` - POST to server with optional `singleFile` and `retentionDays` options, return session ID
- [x] 8.3 Implement `uploadHtmlChunk(sessionId, html, scrollIndex, pageType?, pageUrl?)` - POST HTML chunk with linked page metadata
- [x] 8.4 Implement `scrapeComplete(sessionId, resourceCount)` - POST scrape-complete signal with `{ resourceCount }` body so the server can populate `resources_discovered` for UI progress; MUST be called before finalization
- [x] 8.5 Implement `uploadResource(sessionId, path, blob, originalUrl, contentType)` - multipart upload with gzip compression only for text-based MIME types (`text/*`, `application/javascript`, `application/json`, `application/xml`); binary resources uploaded uncompressed
- [x] 8.6 Implement `uploadFilenameMap(sessionId, map)` - POST JSON filename map (merges with existing on server)
- [x] 8.7 Implement `uploadContent(sessionId, text)` - POST text content for `content.txt` inclusion in ZIP
- [x] 8.8 Implement `finalizeSession(sessionId)` - POST finalize (only accepted in `uploading` status), return 202
- [x] 8.9 Implement `getSessionStatus(sessionId)` - GET status, return status/phase/progress/download URL
- [x] 8.10 Implement `checkHealth()` - GET `/api/v1/health`, verify server availability without auth
  - **Note (S6)**: `chrome.downloads.download` with a non-`blob:` URL requires the URL to be accessible by Chrome. For non-localhost deployments HTTPS is **mandatory**, not merely recommended — Chrome blocks mixed-content downloads from HTTP remote origins. Log a console warning when the server URL uses `http://` and a non-loopback host, and surface a UI warning badge so the operator is aware.
- [x] 8.11 Implement auto-registration: call `POST /api/v1/auth/register` on first use, store API key in `chrome.storage.local`; use a promise-based mutex so concurrent 401 responses trigger at most one re-registration call; re-register on 401 with max 3 attempts and exponential backoff
- [x] 8.12 Implement error classes: `ServerUnavailableError`, `AuthenticationError`, `AssemblyTimeoutError`
- [x] 8.13 Handle 409 Conflict on `finalizeSession`: treat as success and proceed to status polling
- [x] 8.14 Implement retry logic for control-plane calls (`scrapeComplete`, `uploadFilenameMap`, `uploadContent`, `finalizeSession`): 3 retries with exponential backoff (1s, 2s, 4s) on 5xx errors or network timeouts; no retry on 4xx
- [x] 8.15 Verify: all API calls work against running server (integration test with test session)

## 9. Extension - Upload Queue

- [x] 9.1 Create `src/background/upload-queue.ts` with `UploadQueue` class (max 5 concurrent uploads)
- [x] 9.2 Implement upload progress tracking (bytes sent / total bytes per upload)
- [x] 9.3 Implement retry logic (3 retries with exponential backoff for 5xx errors and network timeouts; no retry for 4xx EXCEPT:
  - **429 Rate Limit**: must respect `Retry-After` header or apply exponential backoff
  - **413 Session Full**: treat as a fatal, non-retryable error for that resource upload; immediately trigger the server-failure handling path (task 12.9) rather than silently failing the individual resource. This prevents partial downloads where the user does not know some resources were dropped. (M4 fix.))
- [x] 9.4 Implement queue cancellation (abort in-progress fetches using AbortController, cancel pending uploads)
- [x] 9.5 Implement aggressive blob memory release: streamingly read the blob during upload and immediately nullify references to it upon successful upload to prevent memory accumulation in the extension during slow network conditions
- [x] 9.6 Verify: concurrent uploads work with correct progress tracking, retry behavior, and memory release

## 10. Extension - ServerStorageAdapter

- [x] 10.1 Create `src/background/storage/server-storage-adapter.ts` implementing `IStorageAdapter` interface
- [x] 10.2 Implement `addFile(path, content, mimeType)` to upload via ServerClient + UploadQueue (with gzip only for text-based MIME types; binary uploaded uncompressed)
- [x] 10.3 Implement `getFile(path)` to return null (server storage is write-only from extension)
- [x] 10.3a Implement `getResourceCount()` method on `ServerStorageAdapter` (NOT on `IStorageAdapter` — local mode continues to use `getAllFiles().length` for enumeration). This method returns the current count of resources submitted to the UploadQueue (queued + in-progress + completed), and is used by the UI for "X/Y resources uploaded" progress display. (M1 fix.)
- [x] 10.4 Implement `getAllFiles()` to return empty array (server manages file enumeration)
- [x] 10.5 Implement `clear()` to: (a) immediately abort all pending and in-progress uploads in the UploadQueue via `AbortController.abort()`, AND (b) send `DELETE /api/v1/sessions/{id}`. Both actions must occur together — aborting uploads without deleting the session leaves orphaned server data; deleting the session without aborting uploads causes 404 errors on in-flight requests. (S5 fix.)
- [x] 10.6 Verify: file handlers can use ServerStorageAdapter interchangeably with IndexedDBAdapter

## 11. Extension - Server Download Handler

- [x] 11.1 Create `src/background/server-download.ts` with download from server URL logic
- [x] 11.2 Implement `chrome.downloads.download` with server download URL and custom filename
- [x] 11.3 Implement assembly polling (poll status every 2s after finalize until `ready` or `failed`, max 5 minutes timeout)
- [x] 11.4 Implement local fallback: offer user option to download locally if server fails or times out
- [x] 11.5 Verify: download triggers correctly when server ZIP is ready
- [x] 11.6 Verify: local fallback works when user chooses after server failure

## 12. Extension - Modified Download Core Flow

- [x] 12.1 Modify `src/background/download-core.ts` to detect server mode and branch to server flow
- [x] 12.2 Implement server session creation at download start (replaces local session creation, include `singleFile` and `retentionDays` options)
- [x] 12.3 Modify scrolling flow to upload HTML chunks to server after each scroll
- [x] 12.4 Send scrape-complete signal ONCE — after ALL page scrolling is complete (main page + all linked pages) and every HTML chunk upload has received a 200 ACK from the server; resource uploads may still be in progress at this point
- [x] 12.5 Modify resource processing to use ServerStorageAdapter (images, CSS, JS, documents, fonts are uploaded after download)
- [x] 12.6 Add filename map upload with explicit timing:
  - After `processImages()` completes for the **main page**: call `uploadFilenameMap(sessionId, fullMap)` and await the 200 ACK before proceeding to finalization.
  - After `downloadAssets()` completes for each **linked page**: call `uploadFilenameMap(sessionId, deltaMap)` with only the new entries discovered for that linked page and await the 200 ACK before processing the next linked page. This ensures the server always has the latest mappings when converting each page's HTML. (M3 fix.)
- [x] 12.7 Add content text upload via `uploadContent()` (awaited before finalization)
- [x] 12.8 Replace ZIP generation with server finalization + polling + download URL
- [x] 12.9 Implement server failure handling: detect ServerUnavailableError, display error message with local fallback option (including re-scrape warning), allow retry
- [x] 12.10 Modify linked page scraper to capture DOM in chunks (instead of a single `outerHTML` call to prevent extension memory limits) and upload HTML chunks with `pageType: "linked"` and `pageUrl` for each linked page
- [x] 12.11 Modify linked page scraper to skip already-registered assets (AssetRegistry) and upload incremental filename map updates
- [x] 12.12 Verify: full server-mode download flow works end-to-end (scroll, scrape-complete, upload, finalize, download)
- [x] 12.13 Verify: server-mode linked page scraping uploads HTML and resources correctly

## 13. Extension - Modified Message Handling

- [x] 13.1 Add new message actions to `src/common/message.ts`: `SERVER_CREATE_SESSION`, `SERVER_UPLOAD_HTML_CHUNK`, `SERVER_SCRAPE_COMPLETE`, `SERVER_UPLOAD_RESOURCE`, `SERVER_UPLOAD_CONTENT`, `SERVER_FINALIZE_SESSION`, `SERVER_SESSION_STATUS`, `SERVER_HEALTH_CHECK`, `SERVER_LOCAL_FALLBACK`
- [x] 13.2 Modify `src/background/message.ts` to handle new server-mode message actions
- [x] 13.3 Modify `src/sidepanel/hooks/useScrapingDownloader.ts` to stream HTML chunks during scrolling (instead of accumulating in downloadResponse)
- [x] 13.4 Verify: message flow works for server-mode download initiation and progress

## 14. Extension - Auto-Registration and Build Config

- [x] 14.1 Add `VITE_SERVER_URL` to extension `.env` file and Vite config (injected at build time)
- [x] 14.2 Implement auto-registration flow: call `/api/v1/auth/register` on first use, store API key in `chrome.storage.local`
- [x] 14.3 Implement API key rejection handling: on 401 response, re-register and retry
- [x] 14.4 Add server mode indicator badge in Filter.tsx (visible when `VITE_SERVER_URL` is set)
- [x] 14.5 Verify: auto-registration works, API key is stored, mode badge shows correctly

## 15. Extension - Modified Download Status UI

- [x] 15.1 Modify `src/sidepanel/components/DownloadStatus.tsx` to show upload progress (X/Y resources uploaded)
- [x] 15.2 Add server assembly status display ("Assembling on server..." with assembly phase and progress percentage)
- [x] 15.3 Add "Download from server" button when ZIP is ready
- [x] 15.4 Modify `src/sidepanel/components/DownloadComplete.tsx` to show server download URL with copy button (and `.html` extension for single-file mode)
- [x] 15.5 Add server error display with "Retry" and "Download locally" fallback buttons (include re-scrape warning on local fallback)
- [x] 15.6 Add assembly timeout notification with local fallback option
- [x] 15.7 Add scraping → uploading status transition in UI (after scrape-complete signal)
- [x] 15.8 Verify: UI correctly shows all server-mode states (scraping, uploading, assembling, ready, failed, timeout)

## 16. Extension - Local Mode Backward Compatibility

- [x] 16.1 Verify all existing local-mode flows still work when `VITE_SERVER_URL` is not set
- [x] 16.2 Test that absence of `VITE_SERVER_URL` routes through existing IndexedDB/JSZip path
- [x] 16.3 Test server-unavailable error message with local fallback when server is down and `VITE_SERVER_URL` is set
- [x] 16.4 Test local fallback flow: server error → user chooses local mode → download completes locally

## 17. Integration Testing

- [x] 17.1 Test full server-mode download of a simple page (HTML only)
- [x] 17.2 Test server-mode download with images (filename map upload + conversion)
- [x] 17.3 Test server-mode download with CSS and JS resources (including CSS `url()` rewriting)
- [x] 17.4 Test server-mode download with font files (stored in `fonts/` directory, CSS references use `../fonts/`)
- [x] 17.5 Test server-mode download with linked pages (full website scraping with incremental filename map updates)
- [x] 17.6 Test server-mode single-file HTML download (all resources inlined as base64)
- [x] 17.7 Test server-mode download with content text (`content.txt` included in ZIP)
- [x] 17.8 Test server session expiry and cleanup (including orphaned API key cleanup)
- [x] 17.9 Test auto-registration flow (first use, re-registration on 401, rate limiting)
- [x] 17.10 Test server restart during active upload (stale sessions marked as failed, extension detects failure)
- [x] 17.11 Test server health check endpoint
- [x] 17.12 Test compressed upload (gzip Content-Encoding for text resources only; binary resources uploaded uncompressed)
- [x] 17.13 Test local fallback: server failure → user chooses local mode → re-scrape warning shown → download completes locally
- [x] 17.14 Test assembly timeout: server takes > 5 minutes → timeout error → local fallback option
- [x] 17.15 Test CSS file URL rewriting: CSS `url()` references converted to `../images/` and `../fonts/` in assembled ZIP
- [x] 17.16 Test linked page server flow: HTML chunks with pageType, incremental filename map, AssetRegistry deduplication
- [x] 17.17 Test scrape-complete flow: scraping → scrape-complete → uploading → finalize → assembling → ready
- [x] 17.18 Test finalize rejected in scraping status (must call scrape-complete first)
- [x] 17.19 Test session size limits enforced (413 on upload exceeding 500MB default)
- [x] 17.20 Test resource upload rate limiting (429 after 600 requests/minute per session)
- [x] 17.21 Test UUIDv4 session IDs (non-sequential, non-guessable)
- [x] 17.22 Test CORS configuration allows chrome-extension:// origins
