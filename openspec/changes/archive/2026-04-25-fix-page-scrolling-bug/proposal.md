## Why

Pages with lazy-loaded content are incompletely scraped because the scrolling logic stops before all dynamic content has loaded. In linked pages, `scrollSteps` is calculated once from the initial `scrollHeight` and never updated when content loads and the page grows. On the main page, bottom-detection fires too early — content loads *after* we stop scrolling. Both mechanisms fail to handle layout shifts that cause the page to "jump up," effectively resetting scroll progress without being detected.

## What Changes

- Replace the fixed-step for-loop in `scrollPageForLazyLoading` (linked-page-scraper.ts) with an adaptive while-loop that re-checks `scrollHeight` after each step and continues scrolling if the page has grown
- Make `smoothScrollToBottom` (fn.ts) aware of page height changes, increase step size for faster coverage, and detect layout-shift jumps
- Add page-growth awareness to the bottom-detection check in `useScrapingDownloader.ts` so scrolling doesn't stop when content is still loading; implement a "settle" mechanism that requires height and position stability before declaring bottom

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `linked-pages`: Lazy Loading Support requirement changes from fixed-step scrolling to adaptive scrolling that re-evaluates page height and continues until height stabilizes
- `download-engine`: Server Mode Download Lifecycle and Download State Tracking requirements change to support height-aware bottom detection and settle-before-stop behavior in the main page scroll loop

## Impact

- **Source files**: `src/background/linked-page-scraper.ts`, `src/client/fn.ts`, `src/sidepanel/hooks/useScrapingDownloader.ts`
- **Return type of `smoothScrollToBottom`**: extended with `heightChanged` flag (non-breaking — callers that ignore extra fields are unaffected)
- **Behavior**: Pages that previously stopped scrolling early will now scroll further, potentially increasing download time slightly but capturing more content
- **No API or dependency changes**
