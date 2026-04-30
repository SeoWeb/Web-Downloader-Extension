## Context

The server-mode download flow has a retry button and a "Download locally" fallback button that appear when server assembly fails, times out, or the server is unreachable. Both are currently broken due to missing data in message payloads and stale internal refs that aren't reset between attempts.

The scraping state in `useScrapingDownloader` uses React refs (`serverSessionIdRef`, `serverSessionCreatedRef`, `lastHtmlRef`) to track server session state across scroll iterations. These refs persist across the failed attempt and are not reset when the user clicks Retry, causing the retry to re-use the old failed session.

## Goals / Non-Goals

**Goals:**
- Fix "Retry" to create a fresh server session and re-scrape the page
- Fix "Download locally" to pass valid HTML and download options to the local pipeline
- Add defensive guards to prevent `cheerio.load(undefined)` crashes from any code path

**Non-Goals:**
- Re-using partial results from the failed server session (retry starts fresh)
- Adding retry-with-backoff or circuit-breaker patterns
- Changing the UI layout of error/retry buttons

## Decisions

### Decision 1: Reset refs via `setDownloadResponse(null)` on retry

The `setDownloadResponse` wrapper in `useScrapingDownloader` (lines 260-273) already resets all server refs when called with `null`. Using this existing mechanism is simpler and more consistent than exposing a separate `resetServerRefs()` function.

**Alternative considered**: Expose a dedicated `resetServerRefs()` function that only resets refs without clearing `downloadResponse`. Rejected because `setDownloadResponse(null)` is the designed cleanup path and the brief UI flash is acceptable.

### Decision 2: Expose `lastHtml` from hook as a return value

The local fallback needs the scraped HTML content. In server mode, `downloadResponse?.html` is metadata-only (no accumulated HTML). The `lastHtmlRef.current` holds the last scroll response HTML, which is the best available HTML for the fallback.

**Alternative considered**: Re-scrape the page from the content script during fallback. Rejected because the background already has the HTML in `lastHtmlRef`, and re-scraping adds latency and complexity.

### Decision 3: Defensive guard in `getResources()` returns empty collections

Adding `if (!html || typeof html !== 'string') return { css: [], js: [], ... }` at the top of `getResources` prevents the crash regardless of which code path sends bad data. This is a safety net, not the primary fix.

**Alternative considered**: Throw a descriptive error instead of returning empty. Rejected because returning empty lets the download proceed with just the HTML file (no extracted resources), which is better than crashing.

## Risks / Trade-offs

- **Retry creates orphaned sessions**: The old failed session remains on the server until it expires. Acceptable — the server's retention policy handles cleanup.
- **`lastHtml` is the last scroll response, not the full accumulated HTML**: In server mode, only the last scroll chunk is available in the ref. For the local fallback, this means the downloaded HTML may be incomplete for long pages. Acceptable — the fallback is a best-effort recovery, and the UI already shows a re-scrape warning.
- **`setDownloadResponse(null)` causes brief UI flash**: The progress display clears momentarily before the scraping state appears. Minimal impact — the transition happens within a single render cycle.
