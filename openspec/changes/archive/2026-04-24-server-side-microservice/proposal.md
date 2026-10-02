## Why

The extension currently handles all download, merging, ZIP assembly, and storage in the browser. This creates significant problems: (1) browser memory limits force complex workarounds like split ZIP generation, IndexedDB chunked storage, and side-panel blob URL delegation; (2) users must keep the side panel open throughout the entire download; (3) closing the browser loses all progress; (4) CORS restrictions block many cross-origin resources; (5) only one download can run at a time. Moving resource storage, HTML merging, and ZIP assembly to a Python microservice eliminates these constraints while keeping the extension as the scraping front-end (preserving browser auth, cookies, and JS-rendered DOM capture).

## What Changes

- Add a Python (FastAPI) microservice that receives HTML chunks and resource files from the extension, merges HTML, rewrites URLs to local paths, assembles a ZIP, stores it, and serves it for download
- Extension scrolls pages and sends each HTML chunk to the server immediately (streaming merge instead of in-memory accumulation)
- Extension downloads resources (images, CSS, JS, documents, videos) using the browser's authenticated fetch, then uploads each to the server
- Server performs HTML merging (replacing client-side `merge-html.ts` and `HtmlAssembler.ts`)
- Server performs URL-to-local-path conversion (replacing client-side `html-utils/*` converters)
- Server performs ZIP assembly (replacing client-side `zip-stream-splitter.ts` and JSZip generation)
- User receives a server download link instead of a browser blob download
- Server mode is determined by build-time configuration (`.env` / `VITE_SERVER_URL`), not user action
- API key is auto-generated on first use via registration endpoint; users never see or manage it
- When server is configured but down, extension displays an error with option to fall back to local mode for the current download (requires re-scraping the page)
- Extension signals scraping completion explicitly so the server can transition to `uploading` status
- Text content is uploaded to the server via a dedicated endpoint for `content.txt` inclusion in the ZIP
- Session IDs use UUIDv4 for cryptographic randomness; resource and session size limits are configurable
- Only text-based MIME types (CSS, JS, HTML) are gzip-compressed during upload; binary resources are uploaded as-is
- CORS is configured to allow `chrome-extension://` origins with appropriate methods and headers
- Font files uploaded by the extension are stored in a `fonts/` directory within the ZIP

## Capabilities

### New Capabilities

- `server-api`: REST API for session management, HTML chunk upload, resource upload, finalization, and download retrieval
- `server-html-merge`: Server-side HTML chunk merging and deduplication (replaces client-side `merge-html.ts` and `HtmlAssembler.ts`)
- `server-html-converter`: Server-side HTML URL-to-local-path conversion for images, scripts, stylesheets, links, and objects (replaces client-side `html-utils/*`)
- `server-zip-assembly`: Server-side ZIP archive creation from uploaded resources and merged HTML (replaces client-side split ZIP and JSZip)
- `server-session-storage`: Server-side session and resource persistence with MySQL + file storage (replaces client-side IndexedDB storage)
- `extension-server-client`: Extension-side API client, upload queue (with aggressive blob memory release), and ServerStorageAdapter for communicating with the microservice
- `extension-server-settings`: Auto-registration with server, build-time server URL configuration, and server-unavailable error handling

### Modified Capabilities

- `download-engine`: Download lifecycle changes to use server session when `VITE_SERVER_URL` is configured; HTML is streamed to server per scroll instead of accumulated; finalization triggers server ZIP assembly instead of local ZIP generation
- `storage`: Storage adapter gains a `ServerStorageAdapter` implementation; adapter selection is based on build-time config, not user toggle; session management becomes server-side in server mode
- `html-processing`: HTML merging and URL conversion move to server; extension only sends raw HTML chunks and filename maps
- `streaming`: Split ZIP generation removed in server mode; server creates single ZIP with unlimited size; client-side streaming downloader remains for large resource fetches before upload
- `user-interface`: Download status shows upload progress and server assembly status; DownloadComplete component shows server download link; mode badge indicates server mode when active

## Impact

- **New codebase**: Python FastAPI microservice (~15-20 files) alongside the extension
- **Extension files modified**: `download-core.ts`, `download-processors.ts`, `message.ts`, `useScrapingDownloader.ts`, `DownloadStatus.tsx`, `DownloadComplete.tsx`, `Filter.tsx`, `common/message.ts`, `linked-page-scraper.ts` (to capture HTML in chunks)
- **Extension files added**: `server-client.ts`, `upload-queue.ts`, `server-download.ts`, `ServerStorageAdapter` implementation (with `getAllFiles()` and `clear()` stubs)
- **Extension files simplified/removed**: `merge-html.ts`, `HtmlAssembler.ts`, `zip-stream-splitter.ts`, `download-streaming.ts`, `download-incremental.ts`, `panel-download.ts` (in server mode)
- **New dependency**: Python 3.11+, FastAPI, SQLAlchemy, lxml, BeautifulSoup4, uvicorn, aiofiles (for async file operations), mysqlclient or aiomysql (async MySQL driver)
- **Infrastructure**: Docker deployment, MySQL 8.0+ container, persistent storage volume, HTTPS recommended for API key security
- **API contract**: Extension and server communicate over REST with `/api/v1/` prefix; versioned API to handle extension/server version mismatch; gzip compression supported for text-based resource uploads; incremental filename map merging for linked pages; server-side CSS `url()` rewriting for standalone CSS files
