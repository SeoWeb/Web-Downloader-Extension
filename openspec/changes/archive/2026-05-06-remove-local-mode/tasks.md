## 1. Relocate Shared Types

- [x] 1.1 Move `IStorageAdapter` interface from `src/background/storage/storage-adapter.ts` to `src/background/storage/server-storage-adapter.ts`
- [x] 1.2 Update `IStorageAdapter` import in `src/background/download-processors.ts` to point to `./storage/server-storage-adapter`
- [x] 1.3 Update `IStorageAdapter` import in `src/background/linked-page-scraper.ts` to point to `./storage/server-storage-adapter`
- [x] 1.4 Inline `PanelUnavailableError` class (5 lines) in `src/background/download-core.ts`, replacing the import from `./panel-download`

## 2. Delete Local-Mode-Only Files

- [x] 2.1 Delete `src/background/storage/storage-adapter.ts` (JSZipAdapter, IndexedDBAdapter — IStorageAdapter moved out)
- [x] 2.2 Delete `src/background/storage/database.ts` (Dexie schema)
- [x] 2.3 Delete `src/background/storage/file-store.ts` (IndexedDB file storage)
- [x] 2.4 Delete `src/background/storage/session-manager.ts` (IndexedDB sessions)
- [x] 2.5 Delete `src/background/download-streaming.ts` (local streaming path)
- [x] 2.6 Delete `src/background/download-incremental.ts` (local incremental path)
- [x] 2.7 Delete `src/background/merge-html.ts` (client-side HTML merging)
- [x] 2.8 Delete `src/background/HtmlAssembler.ts` (only used by merge-html)
- [x] 2.9 Delete `src/background/zip-stream-splitter.ts` (local split-ZIP generation)
- [x] 2.10 Delete `src/background/panel-download.ts` (blob URL delegation — PanelUnavailableError moved out)
- [x] 2.11 Delete `src/common/blobStorage.ts` (blob storage for panel-download)
- [x] 2.12 Delete `src/common/server-mode.ts` (IS_SERVER_MODE / SERVER_URL)
- [x] 2.13 Delete `src/background/html-utils/html-converter.ts` (convertHtml, convertToSingleFileHtml)
- [x] 2.14 Delete `src/background/htmlUtils.ts` (barrel re-exporting html-converter)
- [x] 2.15 Delete `src/background/html-utils/link-converter.ts`
- [x] 2.16 Delete `src/background/html-utils/image-converter.ts`
- [x] 2.17 Delete `src/background/html-utils/background-image-converter.ts`
- [x] 2.18 Delete `src/background/html-utils/object-converter.ts`
- [x] 2.19 Delete `src/background/html-utils/style-converter.ts`
- [x] 2.20 Delete `src/background/html-utils/script-converter.ts`

## 3. Simplify download-core.ts

- [x] 3.1 Remove local-mode imports: JSZip, JSZipAdapter, IndexedDBAdapter, SessionManager, FileStore, SplitZipGenerator, convertToSingleFileHtml, finalizeIncrementalMerge
- [x] 3.2 Remove panel-download imports: isPanelAlive, downloadViaPanelAndWait (PanelUnavailableError already inlined)
- [x] 3.3 Remove `USE_INDEXEDDB` constant, `forceLocalModes` map, `setForceLocalMode()`, `clearForceLocalMode()`, `shouldUseServerMode()`
- [x] 3.4 Remove `selectStorageAdapter()` function — inline server-only adapter creation in `downloadResources()`
- [x] 3.5 Remove `_forceLocal` handling in `downloadResources()` and simplify concurrency guard to per-tab only
- [x] 3.6 Remove local-mode memory threshold (keep only server-mode 100MB check)
- [x] 3.7 Delete entire `executeDownload()` function (local-mode pipeline: IndexedDB → JSZip → panel-download → split-ZIP)
- [x] 3.8 In `executeDownloadServerMode()`: remove `shouldUseServerMode()` checks (always true), simplify control flow
- [x] 3.9 Remove `addIndexHtml`, `addIndexHtmlFromBlob`, `addContentText`, `processRegularHtml` imports (local-only)
- [x] 3.10 Remove `convertHtml` import from htmlUtils (local-only linked-page conversion)

## 4. Simplify message.ts

- [x] 4.1 Remove `IS_SERVER_MODE` import from `../common/server-mode`
- [x] 4.2 Remove `mergeHtmlIncremental` import from `./merge-html`
- [x] 4.3 Remove `downloadResourcesWithIncrementalAssembly` import from `./download`
- [x] 4.4 In INITIALIZE_DIFFERENTIAL_SCRAPING: remove `IS_SERVER_MODE` guard — always create server session, remove `mergeHtmlIncremental()` local fallback
- [x] 4.5 In SCROLL_AND_EXTRACT_DIFF: remove `IS_SERVER_MODE` guard — always upload to server, remove `mergeHtmlIncremental()` local fallback
- [x] 4.6 Delete `START_INCREMENTAL_DOWNLOAD` case entirely
- [x] 4.7 Delete `SERVER_LOCAL_FALLBACK` case entirely

## 5. Simplify Background Modules

- [x] 5.1 In `src/background/download.ts` (barrel): remove streaming/incremental imports and exports, remove `streamingDownloader` event listeners
- [x] 5.2 In `src/background/cleanupHandlers.ts`: remove `clearForceLocalMode` import/call, remove `cleanupOldBlobs`/`cleanupDownloadBlobs` imports and calls
- [x] 5.3 In `src/background/download-utils.ts`: remove `initiateDownload()` function and panel-download imports; keep `formatBytes()` and `performInitialCleanup()`
- [x] 5.4 In `src/background/fileHandlers/css.ts`: remove `IS_SERVER_MODE` conditional — always upload raw CSS without rewriting url() references; remove `convertBackgroundImageUrlsToRelative` import
- [x] 5.5 In `src/background/linked-page-scraper.ts`: remove `convertHtml` import, remove `localModePages` array and all `.push()` calls, remove `usedFilenames`/`pageFilenameMap` local collision logic, remove deferred link-conversion loop, remove `!this.options.serverSessionId` else branches
- [x] 5.6 Delete `src/background/fileHandlers/html.ts` (addIndexHtml, addContentText, addIndexHtmlFromBlob — all local-only)
- [x] 5.7 In `src/background/download-processors.ts`: remove `processRegularHtml()`, `addIndexHtmlFromBlob()` re-export, and fileHandlers imports; keep processImages/Assets/Documents/Links

## 6. Simplify UI Components

- [x] 6.1 In `src/common/message.ts`: remove `SERVER_LOCAL_FALLBACK` from `MessageAction` type union and `messageActions` object
- [x] 6.2 In `src/types/filterTypes.ts`: remove `_forceLocal?: boolean` option
- [x] 6.3 In `src/sidepanel.tsx`: remove `IS_SERVER_MODE` import and all conditionals — always pass serverModeState; remove PANEL_CREATE_DOWNLOAD case; remove onLocalFallback callback and SERVER_LOCAL_FALLBACK message
- [x] 6.4 In `src/sidepanel/components/DownloadStatus.tsx`: remove `onLocalFallback` prop, local fallback button, re-scrape warning
- [x] 6.5 In `src/sidepanel/hooks/useScrapingDownloader.ts`: remove `IS_SERVER_MODE` import and all conditionals
- [x] 6.6 In `src/components/Actions.tsx`: remove `IS_SERVER_MODE` import and all conditionals

## 7. Update Configuration and Verify

- [x] 7.1 Update `.env.example`: set `VITE_SERVER_URL=https://server.pagepocket.app`
- [x] 7.2 Run `npx tsc --noEmit` — verify no type errors
- [x] 7.3 Run `npm run build` — verify successful build
- [x] 7.4 Grep audit: verify zero results for `IS_SERVER_MODE`, `forceLocal`, `JSZipAdapter`, `IndexedDBAdapter`, `LOCAL_FALLBACK`, `USE_INDEXEDDB`, `merge-html`, `panel-download`, `zip-stream-splitter`, `download-streaming`, `download-incremental`, `blobStorage`, `convertHtml`, `convertToSingleFileHtml`, `mergeHtmlIncremental`
