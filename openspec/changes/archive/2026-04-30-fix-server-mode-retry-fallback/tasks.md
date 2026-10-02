## 1. Defensive Guards

- [x] 1.1 Add HTML input validation guard in `src/background/resources.ts` `getResources()`: return empty collections when `html` is falsy or not a string, before calling `cheerio.load()`
- [x] 1.2 Add HTML validation guard in `src/background/message.ts` `SERVER_LOCAL_FALLBACK` handler: return `{ success: false, error }` when `data.html` is missing

## 2. Expose Last HTML from Scraping Hook

- [x] 2.1 Add `lastHtml: lastHtmlRef.current` to the return object of `useScrapingDownloader` in `src/sidepanel/hooks/useScrapingDownloader.ts`
- [x] 2.2 Destructure `lastHtml` from `useScrapingDownloader` in `src/sidepanel.tsx`

## 3. Fix Retry Handler

- [x] 3.1 Update `onRetryServer` in `src/sidepanel.tsx` to call `setDownloadResponse(null)` before `setIsScraping(true)` to reset all server session refs and trigger a fresh session creation

## 4. Fix Local Fallback Handler

- [x] 4.1 Update `onLocalFallback` in `src/sidepanel.tsx` to pass `html: lastHtml || downloadResponse?.html` and `downloadOptions` in the `SERVER_LOCAL_FALLBACK` message payload

## 5. Verification

- [ ] 5.1 Verify retry creates a new server session (check console logs for new session ID after retry click)
- [ ] 5.2 Verify local fallback passes HTML and options (check no `cheerio.load()` error in console)
- [ ] 5.3 Verify defensive guards work (call `getResources(undefined)` returns empty collections without crash)
