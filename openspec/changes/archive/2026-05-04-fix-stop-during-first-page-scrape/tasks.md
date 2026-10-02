## 1. Hook changes — distinguish user stop from natural completion

- [x] 1.1 Add `stoppedByUserRef = useRef(false)` to `useScrapingDownloader`
- [x] 1.2 Add a `stopScraping` callback that sends `SCRAPER_STOP` to background via `sendMessageToBackground`, sets `stoppedByUserRef.current = true`, then calls `setIsScraping(false)`
- [x] 1.3 In the download-phase branch of the `useEffect` (`else if (downloadOptions)`), check `stoppedByUserRef.current` and return early (reset ref, skip download) if the stop was user-initiated
- [x] 1.4 In the scrape-phase branch of the `useEffect` (`if (isScraping)`), reset `stoppedByUserRef.current = false` before calling `scrape()` so a prior stop doesn't affect the next session
- [x] 1.5 Return `stopScraping` from the hook

## 2. Component changes — wire new stop callback

- [x] 2.1 In `DownloadStatus.tsx`, replace `setIsScraping` prop with `onStopScraping?: () => void` in both `DownloadStatusProps` and `ScrapingControls` props
- [x] 2.2 In `ScrapingControls.handleStop`, call `onStopScraping?.()` instead of `setIsScraping(false) + sendMessage`
- [x] 2.3 In `sidepanel.tsx`, destructure `stopScraping` from the hook and pass it as `onStopScraping` to `DownloadStatus`
- [x] 2.4 Remove unused `sendMessage` import from `DownloadStatus.tsx` (if no longer needed) — kept: still used by pause/resume handlers
