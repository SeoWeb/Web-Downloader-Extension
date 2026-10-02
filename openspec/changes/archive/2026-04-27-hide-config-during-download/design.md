## Context

Two related visibility bugs in the side panel during active downloads:

1. **Filter reappearing mid-download**: In server mode, `downloadResponse` is set to `{top, height, viewportHeight}` (no `.html` field — HTML is streamed to the server). The old guard `!downloadResponse?.html` was always true in server mode, so the Filter (download button + config) reappeared between the scraping and upload phases.

2. **Pause/stop buttons disappearing mid-download**: The DownloadStatus component only shows pause/stop buttons when `isScraping || isScrapingLinkedPages`. During the upload/processing phase (after scrolling completes but before linked pages start), both are false, so buttons vanish. Server-mode phases (`uploading`, `assembling`, `ready`) also return early without showing buttons.

## Goals / Non-Goals

**Goals:**
- Hide the Filter component throughout the entire download lifecycle (scraping → uploading → processing → linked pages)
- Show pause/stop buttons continuously from download start to completion/failure/cancel, including during upload and processing phases

**Non-Goals:**
- Changing the Filter component's internal logic
- Adding pause/stop functionality to phases that don't support it (the buttons are visual; the background may not support pause during upload)

## Decisions

**Filter visibility: use `!downloadResponse` instead of `!downloadResponse?.html`**

In server mode, `downloadResponse` is always non-null during download (contains scroll metadata). Checking `!downloadResponse` covers all phases. `downloadResponse` is only cleared on completion/failure/cancel/reset.

**Scraping control buttons: show whenever download is in progress**

Instead of checking only `isScraping || isScrapingLinkedPages`, also show buttons when `downloadResponse` is non-null and the download hasn't completed. In server mode, embed pause/stop buttons within the uploading/assembling status cards instead of returning early without them.

**Alternative considered**: a single `isDownloadInProgress` derived boolean. Rejected — would require threading a new prop through multiple components. Using `downloadResponse` as the signal is simpler and already available.

## Risks / Trade-offs

- [Low risk] Pause during upload/assembly sends a message to background that may not be handled — acceptable since the button is primarily for scraping control, and the background will simply ignore it for non-scraping phases. The stop button is useful at any phase to cancel the entire operation.
