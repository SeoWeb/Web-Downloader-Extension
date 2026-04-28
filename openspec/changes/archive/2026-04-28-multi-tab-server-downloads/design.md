## Context

The extension runs a single Manifest V3 service worker shared across all tabs. Currently, five module-level singletons prevent concurrent downloads:

1. `downloadAbortController` — single abort controller
2. `currentScraper` — single linked-page scraper instance
3. `activeServerSessionId` + `serverScrollIndex` — single server session tracker
4. `keepalivePort` — single keepalive connection
5. `isDownloadInProgress` — global boolean in `chrome.storage.local`

Side panel messages are broadcast via `chrome.runtime.sendMessage` with no tab filtering, so Tab A's panel receives Tab B's status updates.

Server mode is already largely session-isolated — each download creates its own server session, `UploadQueue` is per-session, and the server handles assembly independently. The bottleneck is purely client-side state.

## Goals / Non-Goals

**Goals:**
- Allow N concurrent server-mode downloads across N tabs
- Keep local mode single-download (shared IndexedDB/JSZip, memory-heavy)
- Isolate side panel messages per tab
- Clean up per-tab state when tabs close

**Non-Goals:**
- Multiple downloads within the same tab (same tab still blocks on second attempt)
- Changes to server API or server-side logic
- Changes to `RequestQueue`, `MemoryManager`, or `ServerClient` (these are correct as global singletons)
- Concurrent local-mode downloads

## Decisions

### 1. Per-tab Maps keyed by `tabId`

**Decision**: Convert each singleton to `Map<number, T>` keyed by `tabId`.

**Rationale**: `tabId` is already threaded through the entire message pipeline (`data.tabId` in every message). The service worker already receives `tabId` from the side panel and content scripts. This is the smallest change with the least risk.

**Alternative considered**: A `DownloadContext` class wrapping all state per download. Rejected — would require threading a context object through 20+ function signatures. Maps are less elegant but require fewer call-site changes.

### 2. Mode-aware concurrency guard

**Decision**: The guard in `downloadResources()` checks mode:
- **Server mode**: block if `tabId` already has an active download (`isTabDownloadInProgress(tabId)`)
- **Local mode**: block if *any* tab has an active download (`isAnyDownloadInProgress()`)

**Rationale**: Local mode uses shared resources (IndexedDB sessions, JSZip, panel-download blob URLs) that cannot be safely concurrent. Server mode offloads all heavy work to independent server sessions.

### 3. In-memory `Set<number>` for active tab tracking

**Decision**: Replace `chrome.storage.local` boolean with an in-memory `Set<number>` of active tab IDs. Keep `chrome.storage.local` `isDownloadInProgress` as a fallback for SW restart detection only.

**Rationale**: `chrome.storage.local` is async and too slow for hot-path checks. The Set gives O(1) lookup. The `isDownloadInProgress` flag remains for the existing SW restart/recovery flow.

### 4. Side panel message filtering

**Decision**: Add `tabId` to `PANEL_MESSAGE` data and filter in the side panel handler: ignore messages where `data.tabId !== this.tabId`.

**Rationale**: Chrome's messaging API broadcasts to all listeners. Filtering in the receiver is simpler than trying to target specific side panels (which isn't directly supported).

### 5. Tab lifecycle cleanup via `chrome.tabs.onRemoved`

**Decision**: Add a listener in `background.js` that clears all per-tab state when a tab closes.

**Rationale**: Prevents memory leaks in the Maps. Maps are small (one entry per active download), but without cleanup they'd grow indefinitely as tabs open/close.

## Risks / Trade-offs

**[Memory leak from Maps]** → Mitigated by `chrome.tabs.onRemoved` listener. If a download completes normally, the finally block cleans up. The listener handles the abnormal case (tab closed mid-download).

**[Cross-tab message bleed without panel filter]** → Must implement panel filtering (Step 8 in tasks). Without it, Tab A's panel would show Tab B's "Uploading 5/10 resources" messages.

**[Local mode still single-download]** → Acceptable trade-off. Local mode uses shared IndexedDB, JSZip, and panel-download delegation. Making local mode concurrent would require much deeper refactoring of storage and download paths.

**[Service worker restart loses Map state]** → Mitigated by `chrome.storage.local` `isDownloadInProgress` flag, which is still set/cleared for SW restart detection. The per-tab Maps are rebuilt from scratch on SW restart (which already resets all downloads).
