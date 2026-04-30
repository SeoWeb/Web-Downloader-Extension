## Why

Server-mode download failures are unrecoverable: clicking "Retry" re-uses the same failed server session (stale refs aren't reset), and clicking "Download locally" crashes with `cheerio.load() expects a string` because the fallback message is missing `html` and `downloadOptions`. These bugs block the user from completing any download after a server failure.

## What Changes

- Fix `onLocalFallback` to pass `html` and `downloadOptions` in the `SERVER_LOCAL_FALLBACK` message payload so the local pipeline receives the data it needs
- Fix `onRetryServer` to reset server session refs (`serverSessionIdRef`, `serverSessionCreatedRef`, `lastHtmlRef`) so retry creates a fresh server session instead of reusing the failed one
- Expose `lastHtml` from `useScrapingDownloader` hook so the sidepanel can include it in the fallback message
- Add defensive guard in `getResources()` to return empty collections when `html` is not a string, preventing `cheerio.load(undefined)` crashes
- Add defensive guard in `SERVER_LOCAL_FALLBACK` handler to return a clear error when `html` is missing

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `user-interface`: Fix retry and local-fallback handlers in sidepanel to pass required data and reset stale state
- `download-engine`: Add defensive type guard in `getResources()` against non-string HTML input
- `server-session-storage`: Add validation in `SERVER_LOCAL_FALLBACK` message handler for missing HTML content

## Impact

- `src/sidepanel.tsx` — retry and fallback handlers
- `src/sidepanel/hooks/useScrapingDownloader.ts` — expose `lastHtml` from hook return value
- `src/background/resources.ts` — defensive guard in `getResources()`
- `src/background/message.ts` — defensive guard in `SERVER_LOCAL_FALLBACK` handler
