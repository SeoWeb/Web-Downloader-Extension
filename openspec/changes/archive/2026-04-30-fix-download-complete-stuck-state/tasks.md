## 1. DownloadStatus rendering priority

- [x] 1.1 In `src/sidepanel/components/DownloadStatus.tsx`, move the `action === messageActions.DOWNLOAD_DONE` check (currently at line ~389) to immediately after the `interruptData` check (line ~137), before all server-mode phase checks. Remove the old check at the bottom.
- [x] 1.2 Verify no other code paths in DownloadStatus depend on the DOWNLOAD_DONE check being at the bottom.

## 2. DOWNLOAD_COMPLETE state cleanup

- [x] 2.1 In `src/sidepanel.tsx`, inside the `DOWNLOAD_COMPLETE` handler (~line 195), add `setServerModeState((prev) => prev ? { ...prev, phase: 'ready' } : prev)` after `setAction(messageActions.DOWNLOAD_DONE)`.
- [x] 2.2 In the chrome.storage change handler (~line 295), add the same `setServerModeState` call after `setAction(messageActions.DOWNLOAD_DONE)`.

## 3. Storage handler double-processing guard

- [x] 3.1 Add an `actionRef` ref in sidepanel.tsx (`const actionRef = useRef(action); actionRef.current = action;`) to track current action state without adding it to the storage handler's dependency array.
- [x] 3.2 In the storage handler, add an early return when `actionRef.current === messageActions.DOWNLOAD_DONE`: skip message/state updates, just call `chrome.storage.local.remove("downloadComplete")`.
