## Context

The WebsiteDownloader extension has accumulated a dual-pipeline architecture over multiple development phases. The local mode (IndexedDB + JSZip + panel-download) was the original implementation. Server mode was layered on top, adding `IS_SERVER_MODE` conditionals throughout the codebase. The server now handles all HTML merging, URL conversion, ZIP assembly, and single-file inlining — making the local pipeline redundant.

The extension currently has ~26 files dedicated entirely to local-mode logic and ~15 files with mixed local/server branches. Every `IS_SERVER_MODE` check adds cognitive overhead and maintenance burden.

## Goals / Non-Goals

**Goals:**
- Remove all local-mode-only code from the extension
- Remove all mode-selection logic (`IS_SERVER_MODE`, `shouldUseServerMode`, `forceLocalModes`)
- Simplify `download-core.ts` to a single server-mode pipeline
- Delete unused storage layer (IndexedDB adapters, session manager, file store, Dexie schema)
- Delete unused download paths (streaming, incremental, split-ZIP, panel-download)
- Delete unused HTML conversion utilities (client-side relative-path and base64 converters)
- Delete unused blob storage for panel-download flow

**Non-Goals:**
- No server-side changes — server code is untouched
- No API contract changes — extension↔server protocol unchanged
- No new features or logic changes — only removal
- No changes to PagePocket microservices
- No migration of existing user data — local-mode downloads aren't persisted across sessions anyway

## Decisions

### 1. Relocate `IStorageAdapter` to `server-storage-adapter.ts`
The `IStorageAdapter` interface is defined in `storage-adapter.ts` alongside the local-only adapters. It's imported by `ServerStorageAdapter`, `download-processors.ts`, and `linked-page-scraper.ts`. Moving it to `server-storage-adapter.ts` eliminates the need to keep `storage-adapter.ts` alive just for the interface.

**Alternative**: Create a new `types.ts` file for the interface. Rejected — adds a file for a single interface used by one adapter.

### 2. Inline `PanelUnavailableError` in `download-core.ts`
`PanelUnavailableError` is defined in `panel-download.ts` and imported by `download-core.ts` for error handling. After removing panel-download.ts, the class needs a home. It's a 5-line class — inlining in download-core.ts is simpler than creating a separate errors file.

**Alternative**: Move to a shared `errors.ts`. Rejected — only used in one file after cleanup.

### 3. Delete all `html-utils/` converter modules
The entire `html-utils/` directory (link-converter, image-converter, background-image-converter, object-converter, style-converter, script-converter) is only imported by `html-converter.ts`, which is local-only. Server handles all URL conversion during assembly.

### 4. Delete `blobStorage.ts`
Blob storage (IndexedDB for blob transfer between service worker and side panel) is only used by the local panel-download flow. Server mode downloads via `chrome.downloads.download({ url })` directly. The cleanup handlers' blob cleanup calls become dead code too.

### 5. Delete `merge-html.ts` and `HtmlAssembler.ts`
Client-side HTML merging is only used by the local incremental assembly path. Server mode streams HTML chunks to the server, which handles merging.

### 6. Keep `performInitialCleanup()` and `formatBytes()` in `download-utils.ts`
These are general utilities not tied to local mode. `performInitialCleanup()` does memory management, `formatBytes()` is a formatting helper. Only `initiateDownload()` is removed.

## Risks / Trade-offs

**[Risk] No offline capability** → Mitigation: Server mode requires connectivity by design. The extension already checks connectivity before downloads. If needed later, offline support would be a new feature built on a different architecture (e.g., service worker cache).

**[Risk] Removing fallback path** → Mitigation: The local fallback was a safety net for server failures. After removal, server failures show retry UI only. This is acceptable since the server is the canonical pipeline now.

**[Risk] Large file in `download-core.ts`** → Mitigation: The file shrinks significantly after removing ~400 lines of local-mode code. The server-mode flow (`executeDownloadServerMode`) is already well-structured.

**[Risk] Dead code in cleanup handlers** → Mitigation: Remove blob-storage cleanup calls alongside blobStorage.ts deletion. The remaining cleanup handlers (memory management, tab lifecycle) are still valid.
