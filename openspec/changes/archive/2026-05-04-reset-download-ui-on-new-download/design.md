## Context

The side panel uses `action` state to control which UI components render:
- `DownloadComplete` renders when `action === DOWNLOAD_DONE`
- `DownloadStatus` and `Actions` hide when `action === DOWNLOAD_DONE`

When a download finishes, `action` is set to `DOWNLOAD_DONE` and the complete UI appears. If the user then clicks "Start Download", `onClickStartDownload` fires and sets `isScraping = true`, but `action` remains `DOWNLOAD_DONE`. The download runs in the background while the UI insists it's already complete.

## Goals / Non-Goals

**Goals:**
- When a new download starts, reset `action` so the progress UI replaces the complete UI

**Non-Goals:**
- Changing the `reset()` function or the complete/error handlers
- Altering any downstream component logic

## Decisions

**Decision: Reset `action` in `onClickStartDownload`**

Add `setAction(null)` and `setInterruptData(null)` at the start of `onClickStartDownload`. These are the only two state values related to "download finished" that aren't already reset by the existing logic. `isScraping`, `downloadOptions`, and `messages` are already handled correctly.

**Alternatives considered:**
- Call `reset()` inside `onClickStartDownload`: Overkill — would reset messages to `"status.connected"` and clear links, losing the `"status.scraping"` message needed for the stepper.
- Add the reset in the `useScrapingDownloader` hook: Would couple UI state management into a data-fetching hook, breaking separation of concerns.

## Risks / Trade-offs

- **Risk:** `interruptData` could be non-null from a prior interrupted download and affect the UI. → **Mitigation:** Also reset `interruptData` to `null` in `onClickStartDownload`.
- No other risks identified — the change is isolated to two state setters in one function.
