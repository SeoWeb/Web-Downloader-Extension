## Why

The extension maintains two complete download pipelines — local mode (IndexedDB + JSZip + panel-download) and server mode (upload to Python microservice). The server now handles all HTML merging, URL conversion, and ZIP assembly. The local mode code is dead weight that doubles maintenance burden and obscures the active code paths.

## What Changes

- **BREAKING**: Remove entire local-mode download pipeline (IndexedDB storage, JSZip ZIP generation, panel-download blob transfer, streaming/incremental download paths)
- Remove all `IS_SERVER_MODE` / `shouldUseServerMode()` conditionals — extension always uses server mode
- Remove force-local-mode override mechanism (`forceLocalModes` map, `_forceLocal` option, `SERVER_LOCAL_FALLBACK` message)
- Delete local-only storage layer (IndexedDB adapters, session manager, file store, Dexie schema)
- Delete local-only download paths (streaming, incremental, split-ZIP generation)
- Delete local-only HTML conversion utilities (relative-path converters, base64 inlining for single-file)
- Delete blob storage used only for local panel-download flow
- Remove local-mode branches from message handler, linked-page scraper, CSS handler, and UI components
- Remove `SERVER_LOCAL_FALLBACK` message action and UI fallback button

## Capabilities

### New Capabilities

(none — this is purely removal)

### Modified Capabilities

- `download-engine`: Remove local-mode pipeline, force-local override, and mode-selection logic
- `storage`: Remove IndexedDB/JSZip adapters, session manager, file store — keep only server storage adapter interface
- `html-processing`: Remove client-side HTML conversion (relative URLs, base64 inlining) — server handles all conversion
- `linked-pages`: Remove local-mode linked page storage and deferred link conversion — always upload chunks to server
- `streaming`: Remove entire streaming download path (local-only)
- `user-interface`: Remove local fallback button, mode conditionals, PANEL_CREATE_DOWNLOAD handler
- `extension-server-client`: No spec changes, but callers simplified (no mode checks)

## Impact

- **~26 files deleted**: storage adapters, local download paths, HTML converters, blob storage, merge-html, zip-stream-splitter, panel-download
- **~15 files modified**: download-core, message handler, cleanup handlers, CSS handler, linked-page-scraper, download barrel, download-utils, filter types, message types, sidepanel, download-status, useScrapingDownloader, actions component
- **2 types relocated**: `IStorageAdapter` interface moved to server-storage-adapter, `PanelUnavailableError` class moved to download-core
- **No server-side changes**: All server code remains untouched
- **No API changes**: Extension↔server contract unchanged
