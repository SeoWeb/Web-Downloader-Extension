## Context

The Website Downloader Chrome extension currently runs entirely in the browser: scrolling pages, downloading resources, merging HTML, storing files in IndexedDB, assembling ZIPs, and triggering downloads via the side panel. This architecture creates hard constraints: browser memory limits require split-ZIP workarounds and careful memory management; service workers cannot create blob URLs so downloads must be delegated to the side panel; users must keep the panel open; and closing the browser loses all progress.

The extension already has a well-structured codebase with clear separations: `IStorageAdapter` abstracts storage, `RequestQueue` manages concurrent fetches, `HtmlAssembler` handles incremental merging, and `html-utils/*` converters rewrite URLs. This modularity makes it feasible to swap the storage and assembly backends while keeping the scraping front-end intact.

## Goals / Non-Goals

**Goals:**

- Move HTML merging, URL conversion, and ZIP assembly to a Python microservice, eliminating browser memory constraints for these operations
- Keep resource downloading in the extension to preserve browser authentication, cookies, and JS-rendered DOM capture
- Stream HTML chunks to the server during scrolling instead of accumulating in memory
- Allow users to download completed ZIPs from the server at any time (no panel-open requirement)
- Support auto-registration: extension registers with server on first use and receives an API key automatically
- Maintain backward compatibility: local-only mode works when `VITE_SERVER_URL` is not set at build time

**Non-Goals:**

- Server-side browsing or headless scraping (the extension remains the scraping engine)
- Real-time collaborative downloading
- User accounts and registration (API key-based auth is sufficient for single-server multi-user)
- CDN or distributed deployment (single server + Docker is the target)
- Changing the extension's scrolling or DOM capture logic

## Decisions

### D1: FastAPI + MySQL + file storage for the microservice

**Choice**: FastAPI with async SQLAlchemy (aiomysql) and local file storage for resources and ZIPs.

**Alternatives considered**:

- _Flask_: Simpler but lacks native async and auto-generated API docs
- _SQLite_: Zero-config but lacks concurrent write support, row-level locking, and production-grade reliability under multi-client load
- _PostgreSQL_: More robust but heavier operational overhead for single-server deployment; MySQL is more commonly available in shared hosting
- _Object storage (S3/MinIO)_: Adds infrastructure complexity; local filesystem is sufficient for single-server

**Rationale**: FastAPI gives async I/O, automatic OpenAPI docs, and type validation with Pydantic. MySQL provides concurrent write support with InnoDB row-level locking, crash recovery via the redo log, and well-understood operational tooling. It handles multiple extension clients uploading simultaneously without write contention. Local file storage avoids object storage complexity. MySQL 8.0+ is required for proper JSON column support and window functions. **Schema management uses Alembic exclusively** — `init_db()` on server startup simply calls `alembic upgrade head`; no SQLAlchemy `create_all()` is used alongside Alembic to avoid "unmanaged table" conflicts.

### D2: REST API (not WebSocket) for extension-server communication

**Choice**: Standard REST endpoints for all operations. Polling for status updates.

**Alternatives considered**:

- _WebSocket for real-time progress_: More responsive but adds connection management complexity
- _Server-Sent Events (SSE)_: One-directional real-time, simpler than WebSocket, but still needs REST for uploads and adds server-side connection state

**Rationale**: The upload flow is inherently request-response (upload file, get confirmation). Status polling every 2 seconds is acceptable for assembly progress. SSE could be added in a future iteration for assembly progress if polling proves too chatty, but REST polling is simpler to implement correctly for v1.

### D3: Extension downloads resources, then uploads to server (double bandwidth)

**Choice**: Extension fetches resources from origin sites using browser context (preserving auth/CORS), then uploads each to the server.

**Alternatives considered**:

- _Server fetches resources directly_: Eliminates double bandwidth but loses browser cookies/auth, cannot handle CORS-blocked resources, and cannot scrape JS-rendered pages
- _Extension sends resource URLs only, server fetches_: Server has no CORS restrictions, but loses auth context and cannot access authenticated resources

**Rationale**: Preserving browser auth is critical for sites behind login walls. The double-bandwidth tradeoff is acceptable because: (1) most resources are small (CSS, JS, images), (2) the server and user may be on the same network, (3) the reliability gain outweighs the bandwidth cost.

### D4: ServerStorageAdapter implements IStorageAdapter interface

**Choice**: Create a `ServerStorageAdapter` that implements the existing `IStorageAdapter` interface, uploading files to the server instead of storing in IndexedDB.

**Alternatives considered**:

- _Modify each file handler directly_: More invasive changes, harder to maintain local-mode compatibility
- _Separate upload pipeline_: Duplicates logic between local and server paths

**Rationale**: The `IStorageAdapter` abstraction already exists and is used by all file handlers. A new implementation that uploads to the server means file handlers (`css.ts`, `js.ts`, `images.ts`, etc.) require minimal changes -- they still call `storage.addFile(path, blob, contentType)` but the backend changes.

### D5: Server-side HTML merging ports the existing algorithm

**Choice**: Port the current `merge-html.ts` + `HtmlAssembler.ts` logic to Python using `lxml` + `BeautifulSoup4`.

**Alternatives considered**:

- _Use Python's html5lib_: Slower than lxml, but more lenient parsing
- _Simple string concatenation_: Loses deduplication and intelligent merge

**Rationale**: The existing merge algorithm works well (parent-selector-based merging, deduplication, safe fallback). Porting it preserves behavior while using Python's faster HTML parsing. lxml is the Python equivalent of cheerio.

### D6: Auto-registration with API key

**Choice**: Extension auto-registers with the server on first use via `POST /api/v1/auth/register`, receiving an API key that is stored in `chrome.storage.local`. The user never sees or manages the API key. If the key is rejected (401), the extension re-registers automatically. Session IDs use UUIDv4 for cryptographic randomness, making them non-guessable download tokens.

**Alternatives considered**:

- _User-configured API key_: Requires user to manage keys, adds UI complexity, and creates support burden
- _JWT tokens_: More secure but requires login flow and token management
- _No auth_: Only viable for personal use; rejected for security
- _UUIDv1 session IDs_: Predictable (MAC-based); unsuitable as implicit download tokens

**Rationale**: Auto-registration is the simplest approach for a single-server deployment. The user does not need to know about API keys at all. UUIDv4 session IDs provide 122 bits of entropy, making enumeration infeasible. The extension handles registration and key storage transparently.

### D7: Build-time configuration for server mode

**Choice**: Server mode is determined by the `VITE_SERVER_URL` environment variable set at build time (from the `.env` file). When the variable is set, the extension uses server mode. When not set, it uses local mode. The user cannot toggle between modes.

**Rationale**: Server mode is the default when configured, but the user is offered a local fallback when the server is unreachable. This prevents users from being completely blocked by server outages while keeping the server path as the primary workflow. The `.env` file controls the default mode at build time, keeping the extension simple. If the server is down, the extension shows an error with a "Download locally" fallback option.

### D8: Local fallback when server is unavailable

**Choice**: When the server is configured but unreachable, the extension offers the user an option to fall back to local mode for the current download. The user is explicitly warned that falling back requires re-scraping the page from scratch, since all previously uploaded HTML chunks and resources reside on the server and are not available locally.

**Alternatives considered**:

- _No fallback (hard fail)_: Simpler but blocks users entirely during server outages; poor UX
- _Automatic fallback_: Could confuse users about where their data is stored; silent mode switch is unexpected

**Rationale**: An explicit user choice with a clear re-scrape warning preserves transparency while avoiding total blockage. The server mode indicator remains active for future downloads -- only the current download falls back to local mode.

### D9: Gzip compression for text-based resource uploads only

**Choice**: Only text-based MIME types (CSS, JS, HTML, plain text) are gzip-compressed before upload to the server. Binary resources (images, videos, PDFs, fonts) are uploaded uncompressed, since they are already compressed and gzip would add CPU overhead with negligible bandwidth savings.

**Alternatives considered**:

- _No compression_: Simpler but wastes bandwidth on text resources that compress 3-5x
- _Compress all resources_: Binary files (JPEG, PNG already compressed, MP4, PDF) don't benefit from gzip; wasted CPU on both sides and can even increase size slightly

**Rationale**: Text resources compress well and represent a significant portion of uploads. Binary resources are already compressed by their codec and would not shrink further. The server already needs to decompress for URL conversion (CSS), so the CPU cost for text is justified. The extension checks the MIME type prefix (`text/*`, `application/javascript`, `application/json`) before applying gzip.

### D10: CSS file URL rewriting on server-side

**Choice**: The server rewrites `url()` references inside standalone CSS files (stored at `styles/`) during finalization, converting absolute URLs to relative local paths (`../images/`).

**Alternatives considered**:

- _Client-side CSS rewriting (current approach)_: Works but requires the extension to parse CSS content before upload; complex and error-prone
- _Skip CSS rewriting_: Breaks offline viewing for pages using CSS background images

**Rationale**: The server already handles URL conversion for HTML. Extending this to CSS files is consistent and ensures offline viewing works correctly for all resource types. The CSS files are stored on the server's filesystem, making rewriting straightforward. **Client-side gate**: In server mode the CSS file handler (`fileHandlers/css.ts`) uploads raw CSS without any `url()` rewriting, preventing double-rewriting. The `IS_SERVER_MODE` guard is set at build time from `VITE_SERVER_URL`.

### D11: Explicit scraping completion signal

**Choice**: The extension sends `POST /api/v1/sessions/{id}/scrape-complete` after all HTML chunks have been uploaded. This transitions the server session from `scraping` to `uploading` status, indicating that HTML scraping is done but resource uploads may still be in progress. Finalization (`POST /api/v1/sessions/{id}/finalize`) is only accepted when the session is in `uploading` status.

**Alternatives considered**:

- _Auto-detect scraping completion_: Server cannot know when the extension has finished scrolling; the last HTML chunk doesn't mean scraping is done (there could be more scrolls)
- _Scraping complete flag on last HTML chunk_: Couples scraping metadata with upload payload; harder to handle retries
- _Remove `uploading` status entirely_: Would go directly from `scraping` to `assembling`, losing the ability to track the upload-only phase

**Rationale**: An explicit signal is unambiguous and allows the server to enforce that finalization only happens after HTML scraping is complete. The `uploading` status provides meaningful progress to the UI ("Uploading X/Y resources...").

### D12: Linked page server-side processing with incremental filename map

**Choice**: Linked page HTML is captured in chunks (to avoid browser memory spikes from a single massive `outerHTML` call) and uploaded with `pageType: "linked"` and `pageUrl` metadata. The server merges each linked page's HTML separately. The filename map is updated incrementally as linked pages discover new images.

**Chunking mechanism (C3 resolution)**: Since linked pages have no scroll loop, chunking is done by splitting the serialized `<body>` children into groups of ~512 KB each. The extension calls `chrome.scripting.executeScript` once per linked page to: (a) build a skeleton by replacing the body with an empty `<body></body>`, and (b) collect each top-level body child's `outerHTML` individually. The caller groups children into 512 KB batches and reconstructs each batch as a valid HTML document (skeleton + body open + children + `</body>` + rest). This caps the JS string held in extension memory per upload at ~512 KB regardless of page size. Falls back to single-shot `outerHTML` if scripting fails.

**Filename map timing (M3 resolution)**:
- Main page: full filename map is uploaded once after `processImages()` completes.
- Each linked page: delta map (only new entries from that page) is uploaded after `downloadAssets()` completes for that page, before the next page begins processing. This ensures the server always holds an up-to-date mapping for URL conversion.

**Alternatives considered**:

- _Client-side HTML conversion for linked pages_: Inconsistent with server-side processing for main page; extension would need to keep html-utils in server mode
- _Upload all HTML at the end_: Loses the streaming benefit; requires holding all linked page HTML in memory

**Rationale**: Streaming linked page HTML to the server as pages are scraped maintains the memory-efficient architecture. Incremental filename map updates ensure the server has the latest image mappings when converting each page's HTML.

## Risks / Trade-offs

- **[Double bandwidth]** Resources travel origin-site → extension → server. Mitigation: gzip compression on text-based resource uploads only (binary resources already compressed); most resources are small; the reliability gain is worth the cost.
- **[Server availability]** If the server is down, server-mode downloads fail. Mitigation: Extension detects server unavailability and displays an error with a "Download locally" fallback option that warns about re-scraping. The user can choose to fall back to local mode for the current download.
- **[Upload latency]** Uploading large files (videos, PDFs) to the server adds latency. Mitigation: concurrent uploads (3-5 parallel); progress tracking; the extension already downloads these files so upload can overlap with the next resource download.
- **[HTML merge fidelity]** Porting merge logic to Python may produce slightly different results. Mitigation: test against the same inputs; keep the client-side merge as fallback during transition.
- **[Security]** API keys stored in extension storage could be extracted. Mitigation: HTTPS required for server communication; keys are scoped to download operations only; no user PII is stored; rate limiting on registration prevents key enumeration; UUIDv4 session IDs are non-guessable.
- **[Storage growth]** Server accumulates ZIPs over time. Mitigation: auto-expiry (default 7 days); cleanup cron job; configurable retention per user; orphaned API key cleanup after 30 days.
- **[CSS rewriting fidelity]** Server-side CSS `url()` rewriting may not handle all edge cases (e.g., CSS variables, `@import` chains). Mitigation: port the existing `convertBackgroundImageUrlsToRelative` logic; test against real-world CSS; already-relative paths and data URIs are preserved unchanged.
- **[Local fallback re-scrape cost]** Falling back to local mode after a server failure requires re-scraping the page because HTML chunks and resources were streamed to the server and not retained locally. Mitigation: the UI explicitly warns the user before triggering fallback; the re-scrape is unavoidable given the streaming architecture.
- **[Two build variants]** Build-time `VITE_SERVER_URL` means two separate extension builds (server mode vs local-only). Mitigation: document clearly in the Chrome Web Store listing and README; the default build (no server URL) works standalone.
- **[Server restart data loss]** If the server restarts during active sessions, in-progress uploads are lost. Mitigation: sessions in `scraping` or `uploading` status that were last updated more than 30 minutes ago are marked `failed` on startup; the extension detects the failure and offers local fallback. **`updated_at` must be touched on every HTML chunk upload and every resource upload** (not only on status transitions) to prevent false stale-session detection during heavy uploads of many small resources. (S3 fix.)
- **[Multi-browser concurrency]** Multiple browsers may use the same server. Mitigation: isolation is enforced via UUIDv4 session IDs and API keys. Resource storage paths use session-specific directories. HTML chunk paths include page URL hashes to prevent linked page collisions.
- **[Task cancellation]** `DELETE /sessions/{id}` must stop background assembly. Mitigation: the assembly service uses responsive cancellation mechanisms (e.g., Python `asyncio.Task.cancel()` or threading `Event`). If polling is used for check-pointing, it must occur at fine enough granularity (e.g., between every file added to the ZIP) to ensure immediate termination. If the session is no longer `assembling`, the task aborts and partial files are cleaned.
- **[MySQL operational overhead]** MySQL requires separate process, user management, and backup strategy vs SQLite. Mitigation: Docker Compose includes MySQL container with default configuration; database is primarily append-heavy with simple queries; InnoDB handles crash recovery automatically.
- **[Blob Memory Accumulation]** If network upload speeds are slower than download speeds, Blob objects can accumulate in the extension's memory. Mitigation: `ServerStorageAdapter` and `UploadQueue` aggressively dereference blobs immediately upon successful upload to allow the browser's garbage collector to free memory.
- **[Single-File Base64 Generation Memory]** Base64 encoding large images and injecting them into a single HTML string can cause sudden RAM spikes on the server. Mitigation: String assembly for single-file mode is done streamingly or using generator-based writes to prevent massive memory allocation.
- **[HTTPS requirement for downloads]** `chrome.downloads.download` with a non-`blob:` URL requires the URL to be reachable by Chrome. For non-localhost server deployments HTTPS is **mandatory** — Chrome blocks mixed-content (HTTP) downloads from remote origins. The extension logs a console warning and shows a UI badge when the configured server URL uses `http://` with a non-loopback host. Users deploying on a local network should still use HTTPS or accept the limitation. (S6 fix.)
- **[Session upload abort on cancellation]** When `ServerStorageAdapter.clear()` is called (user cancels download), both actions must happen atomically: (a) abort all pending/in-progress UploadQueue fetches via `AbortController.abort()`, AND (b) send `DELETE /sessions/{id}`. Aborting without deleting leaves orphaned server data; deleting without aborting causes 404 errors on in-flight requests. The server's stale-session cleanup (30-minute timeout) is a backstop but not a substitute. (S5 fix.)
