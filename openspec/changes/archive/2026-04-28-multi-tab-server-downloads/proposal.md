## Why

The extension uses global singletons (abort controller, scraper instance, keepalive port, server session, in-progress flag) that prevent any concurrent downloads. A user downloading site A in Tab 1 is blocked from downloading site B in Tab 2, even though server mode offloads ZIP assembly to the server and each tab has its own independent session.

## What Changes

- Convert all server-mode download state from global singletons to per-tab Maps keyed by `tabId`
- Make the concurrency guard mode-aware: server mode blocks only per-tab, local mode keeps global block
- Route side panel messages by `tabId` so each tab's panel shows only its own download status
- Add tab lifecycle cleanup (`chrome.tabs.onRemoved`) to prevent memory leaks from per-tab Maps

## Capabilities

### New Capabilities
- `concurrent-downloads`: Per-tab download state management, mode-aware concurrency guard, and tab lifecycle cleanup for concurrent server-mode downloads across multiple browser tabs

### Modified Capabilities
- `download-engine`: Concurrency guard changes from global boolean to mode-aware per-tab check; abort controller, keepalive port, and scraper become per-tab
- `extension-server-client`: Server session tracking (`activeServerSessionId`, `serverScrollIndex`) becomes per-tab; message handlers route by `tabId`
- `user-interface`: Side panel filters incoming messages by `tabId` to isolate multi-tab status display

## Impact

- **Core files**: `download-state.ts`, `scraper-state.ts`, `message.ts`, `download-core.ts`, `download-incremental.ts`, `download-listener.ts`, `download.ts`
- **UI**: `sidepanel.tsx` (message filtering)
- **Entry point**: `background.js` (tab lifecycle cleanup, startup reset)
- **No API changes**: All changes are internal to the extension service worker and side panel
- **No dependencies added**: Uses existing `chrome.tabs.onRemoved` API
