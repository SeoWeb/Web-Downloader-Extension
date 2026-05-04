## Context

The side panel's scraping flow has two phases managed by `useScrapingDownloader`:

1. **Scrolling phase**: The hook iteratively calls `startScrolling()` (injecting `smoothScrollToBottom` into the tab), accumulating HTML via `downloadResponse`. When the bottom is reached naturally, `setIsScraping(false)` is called.
2. **Download phase**: When `isScraping` becomes `false` and `downloadOptions` exists, the `useEffect` calls `startDownload(htmlForDownload)`.

The Stop button (`ScrapingControls` in `DownloadStatus.tsx`) calls `setIsScraping(false)` directly. This triggers the `useEffect` to enter the download branch as if the page had reached the bottom normally. The `SCRAPER_STOP` message sent to the background has no effect during this phase because neither a `LinkedPageScraper` nor a download `AbortController` exists yet.

The hook cannot currently distinguish between "scraping completed naturally" and "user pressed Stop".

## Goals / Non-Goals

**Goals:**
- When the user presses Stop during first-page scrolling, the download must NOT start
- The one in-flight `scrape()` iteration may complete (acceptable — one extra scroll before stopping)
- Existing stop behavior during linked page scraping, uploads, and assembly must remain unchanged
- Minimal code changes (3 files, no new dependencies)

**Non-Goals:**
- Aborting the currently in-flight `chrome.scripting.executeScript` call (not feasible in MV3 service workers)
- Preventing all scrolls after Stop — the current in-progress scroll will finish
- Changing the background `SCRAPER_STOP` handler
- Adding pause/resume for first-page scrolling

## Decisions

### Decision 1: Use a `useRef` for the stop flag (not state)

Use a `stoppedByUserRef = useRef(false)` in the hook. A ref is chosen over state because:
- Setting `isScraping` to `false` already triggers a re-render — a second state update would cause an unnecessary double render
- The ref value is only checked in the `useEffect`, which runs after render
- No component needs to render differently based on whether the stop was user-initiated (the UI already shows the "Connected" state after stop)

**Alternative considered**: A new `isCancelled` state in `sidepanel.tsx`. Rejected because it adds a state variable that's only checked once in an effect, and requires threading through multiple component layers.

### Decision 2: Expose a `stopScraping` callback from the hook

The hook already manages all scraping lifecycle concerns (`isScraping`, `downloadResponse`, etc). It should also own the stop signal. The hook returns a new `stopScraping: () => Promise<void>` that:
1. Sends `SCRAPER_STOP` to the background (preserving the existing message)
2. Sets `stoppedByUserRef.current = true`
3. Calls `setIsScraping(false)`

This consolidates all stop logic in one place. `DownloadStatus` no longer needs to know about `sendMessage` or `messageActions.SCRAPER_STOP`.

**Alternative considered**: Keep message-sending in `DownloadStatus` and only pass a ref-setter. Rejected because it splits stop logic across two files and requires `DownloadStatus` to import `sendMessage` and `messageActions`.

### Decision 3: Pass `onStopScraping` to `DownloadStatus` as a prop

Replace the `setIsScraping: (value: boolean) => void` prop with `onStopScraping?: () => void`. This is the only call site for `setIsScraping` in `DownloadStatus` (it's only passed to `ScrapingControls.handleStop`). The `ScrapingControls` sub-component also receives this new prop.

**Alternative considered**: Keep `setIsScraping` and add a separate `onStop` prop. Rejected because `DownloadStatus` should not have two ways to influence the same state — it creates ambiguity.

### Decision 4: Reset the stop ref when a new scrape begins

In the `useEffect`, when `isScraping` is `true`, reset `stoppedByUserRef.current = false` before calling `scrape()`. This ensures that a previous stop doesn't affect the next download session.

## Risks / Trade-offs

- **[Risk] In-flight scroll iteration completes after Stop** → **Mitigation**: One extra `executeScript` call runs harmlessly; the scroll result is discarded because `isScraping` is already false and the effect won't re-trigger the scrape loop.
- **[Risk] User rapidly clicks Stop then Start** → **Mitigation**: The ref is reset to `false` when `isScraping` transitions to `true`, so the new session proceeds normally.
- **[Trade-off] `DownloadStatus` loses direct access to `setIsScraping`** → **Acceptable**: `DownloadStatus` only ever called `setIsScraping(false)` in one place (the stop button). No other component uses this pattern.
