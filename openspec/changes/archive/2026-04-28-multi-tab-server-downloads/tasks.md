## 1. Per-tab download state (`download-state.ts`)

- [x] 1.1 Replace `downloadAbortController` singleton with `Map<number, AbortController>`. Update `getDownloadAbortController(tabId)`, `setDownloadAbortController(controller, tabId)`, `abortActiveDownload(tabId)` to use the per-tab map
- [x] 1.2 Replace `keepalivePort` singleton with `Map<number, Port>`. Update `createKeepalivePort(tabId)`, `disconnectKeepalivePort(tabId)`, `getKeepalivePort(tabId)`, `setKeepalivePort(port, tabId)` to use the per-tab map
- [x] 1.3 Replace `isDownloadInProgress` boolean with in-memory `Set<number>` of active tab IDs. Add `setTabDownloadActive(tabId)`, `setTabDownloadComplete(tabId)`, `isAnyDownloadInProgress()`, `isTabDownloadInProgress(tabId)` functions. Keep `chrome.storage.local` sync for SW restart detection
- [x] 1.4 Update `trackDownload()` to accept mandatory `tabId` and use per-tab keepalive port

## 2. Per-tab scraper state (`scraper-state.ts`)

- [x] 2.1 Replace `currentScraper` singleton with `Map<number, LinkedPageScraper>`. Update `setCurrentScraper(tabId, scraper)`, `pauseScraping(tabId)`, `resumeScraping(tabId)`, `stopScraping(tabId)` to accept and use `tabId`

## 3. Per-tab server session state (`message.ts`)

- [x] 3.1 Replace `activeServerSessionId` and `serverScrollIndex` singletons with `Map<number, { sessionId, scrollIndex }>`. Update `setActiveServerSession(tabId, sessionId)`, `getActiveServerSessionId(tabId)`, `hasStreamedHtmlChunks(tabId)` to use per-tab map
- [x] 3.2 Update `createServerSession()` to accept `tabId` and store in per-tab map
- [x] 3.3 Update all message handlers in `messageWorker()` to pass `data.tabId` to per-tab functions: `SCRAPER_PAUSE`, `SCRAPER_RESUME`, `SCRAPER_STOP` → pass `data.tabId` to scraper-state; `SCROLL_AND_EXTRACT_DIFF`, `SERVER_UPLOAD_HTML_CHUNK`, `SERVER_SCRAPE_COMPLETE`, `SERVER_UPLOAD_RESOURCE`, `SERVER_UPLOAD_CONTENT`, `SERVER_FINALIZE_SESSION`, `SERVER_SESSION_STATUS` → use per-tab session state
- [x] 3.4 Update `INITIALIZE_DIFFERENTIAL_SCRAPING` handler to pass `data.tabId` to `createServerSession`
- [x] 3.5 Update `SERVER_LOCAL_FALLBACK` handler to clear per-tab session state using `data.tabId`

## 4. Mode-aware concurrency guard (`download-core.ts`)

- [x] 4.1 Replace `forceLocalMode` boolean with `Map<number, boolean>`. Update `setForceLocalMode(tabId, value)` and `shouldUseServerMode(tabId)` to use per-tab map
- [x] 4.2 Replace the global `getDownloadInProgress()` guard with mode-aware logic: server mode → `isTabDownloadInProgress(tabId)`, local mode → `isAnyDownloadInProgress()`
- [x] 4.3 Update `downloadResources()` try/finally to use `setTabDownloadActive(tabId)` / `setTabDownloadComplete(tabId)`, pass `tabId` to `createKeepalivePort(tabId)`, `setDownloadAbortController(controller, tabId)`, `disconnectKeepalivePort(tabId)`. Clean up forceLocalModes entry in finally
- [x] 4.4 Update all internal calls in `downloadResources`, `executeDownload`, `executeDownloadServerMode`, and `selectStorageAdapter` to pass `tabId` to `shouldUseServerMode`, `getActiveServerSessionId`, `setActiveServerSession`, `setCurrentScraper`, `hasStreamedHtmlChunks`

## 5. Guard update for incremental path (`download-incremental.ts`)

- [x] 5.1 Update the concurrency guard and in-progress tracking to use `isAnyDownloadInProgress()` / `setTabDownloadActive(tabId)` / `setTabDownloadComplete(tabId)` (this path is local-only)

## 6. Per-tab keepalive cleanup (`download-listener.ts`)

- [x] 6.1 Update keepalive port disconnect logic: when a download completes/interrupted/erased, check if that tab has remaining downloads. Disconnect only that tab's keepalive port via `disconnectKeepalivePort(downloadInfo.tabId)`

## 7. Update re-exports (`download.ts`)

- [x] 7.1 Update imports and re-exports from `setDownloadInProgress`/`getDownloadInProgress` to new per-tab function names

## 8. Side panel message isolation (`sidepanel.tsx`)

- [x] 8.1 Add `tabId` filtering in the `PANEL_MESSAGE` handler: ignore messages where `data.tabId` is set and doesn't match the panel's `tabId`
- [x] 8.2 Add `tabId` filtering in `DOWNLOAD_COMPLETE`, `DOWNLOAD_FAILED`, `DOWNLOAD_CANCELLED` handlers
- [x] 8.3 Update `sendMessageToPanel()` in `message.ts` to accept and include `tabId` in the message data payload

## 9. Tab lifecycle and startup (`background.js`)

- [x] 9.1 Add `chrome.tabs.onRemoved` listener that cleans up all per-tab state: abort controller, keepalive port, scraper, session state, forceLocalMode entry, active downloads set
- [x] 9.2 Update startup reset to include `activeDownloadTabIds: []` in the `chrome.storage.local.set` call

## 10. Verification

- [x] 10.1 Verify TypeScript compilation passes with no errors
- [x] 10.2 Manual test: two tabs with simultaneous server-mode downloads both complete independently
- [x] 10.3 Manual test: stopping one tab's download does not affect the other tab
- [x] 10.4 Manual test: closing a tab mid-download cleans up state and does not affect other tabs
- [x] 10.5 Manual test: local mode still blocks concurrent downloads across tabs
