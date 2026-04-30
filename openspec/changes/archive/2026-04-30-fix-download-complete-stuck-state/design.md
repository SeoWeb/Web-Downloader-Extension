## Context

Server-mode downloads have two completion signals that race:

1. **`status.complete` PANEL_MESSAGE** — sent by `download-core.ts` after `downloadWithFallback` returns. Transitions `serverModeState.phase` to `ready` via `applyServerModeMessage`.
2. **`DOWNLOAD_COMPLETE` message** — sent by `download-listener.ts` when Chrome's `chrome.downloads.onChanged` fires. Sets `action = DOWNLOAD_DONE` in sidepanel.

These travel through the same `chrome.runtime.sendMessage` channel but originate from different async sources. When the file is small or the download is fast, `DOWNLOAD_COMPLETE` can arrive at the sidepanel before `status.complete` is processed.

Additionally, `chrome.storage.local.set({ downloadComplete })` in `download-listener.ts` triggers the storage change handler in sidepanel.tsx as a second path to the same completion state. Both handlers push duplicate messages (`status.scraped`, `status.creating`, `status.complete`).

## Goals / Non-Goals

**Goals:**
- DownloadStatus always hides when the download is done, regardless of `serverModeState.phase`
- `serverModeState` is consistent after download completion (phase = `ready`)
- No duplicate message pushes from dual completion paths

**Non-Goals:**
- Changing the message ordering or timing (we can't control Chrome's event delivery)
- Changing the download-engine or server-download flow
- Adding new UI states or phases

## Decisions

1. **Move DOWNLOAD_DONE check to top of DownloadStatus** — The `action === DOWNLOAD_DONE` return-null guard currently sits at line 389, after all server-mode phase checks. When `serverModeState.phase === 'uploading'` and `action === DOWNLOAD_DONE`, the uploading UI renders and the hide is never reached. Moving it immediately after the interrupt check (before all phase checks) ensures the component always hides when the download is complete.

2. **Reset serverModeState in DOWNLOAD_COMPLETE handler** — When `DOWNLOAD_COMPLETE` arrives, set `serverModeState.phase = 'ready'`. This makes the state self-consistent even if `status.complete` PANEL_MESSAGE arrives late or was missed. Implemented via `setServerModeState(prev => ({ ...prev, phase: 'ready' }))`.

3. **Guard storage handler against double-processing** — The storage handler fires in addition to the message handler. If `action` is already `DOWNLOAD_DONE`, skip the message/state updates and just clean up the storage entry. Uses a ref to avoid stale closure over `action`.

## Risks / Trade-offs

- **Moving DOWNLOAD_DONE check up**: Minimal risk — it's a pure hide guard that only returns null when the download is explicitly done. No other rendering logic depends on the check order.
- **Setting phase='ready' in DOWNLOAD_COMPLETE**: This is a defensive reset. If `status.complete` arrives afterward, `applyServerModeMessage` also sets phase='ready', so it's idempotent.
- **Storage handler ref**: Adds a ref (`actionRef`) that must be kept in sync. Minimal complexity — one extra `useEffect` to update it.
