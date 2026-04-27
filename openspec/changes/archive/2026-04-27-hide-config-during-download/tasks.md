## 1. Pass linked page scraping state to MainContent

- [x] 1.1 Add `isScrapingLinkedPages` prop to `MainContentProps` interface in `src/sidepanel/components/MainContent.tsx`
- [x] 1.2 Pass `isScrapingLinkedPages={isScrapingLinkedPages}` to `MainContent` in `src/sidepanel.tsx`

## 2. Update Filter visibility guard

- [x] 2.1 Add `!isScrapingLinkedPages` to the Filter render condition in `MainContent` and change `!downloadResponse?.html` to `!downloadResponse` (server mode sets downloadResponse without `.html`, so the old check was insufficient)

## 3. Show pause/stop buttons during all download phases

- [x] 3.1 Add pause/stop buttons to the server-mode uploading phase in DownloadStatus (lines 212-243), embedded within the upload status card
- [x] 3.2 Add pause/stop buttons to the server-mode assembling phase in DownloadStatus (lines 171-207), embedded within the assembly status card
- [x] 3.3 Add pause/stop buttons to the local-mode downloading phase in DownloadStatus (lines 296-307), replacing the plain text with a card that includes buttons
- [x] 3.4 Verify type-check passes
