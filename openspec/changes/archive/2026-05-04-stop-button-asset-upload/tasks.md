## 1. Implementation

- [x] 1.1 In `src/sidepanel/hooks/useScrapingDownloader.ts`, modify the `stoppedByUserRef` guard (lines 228-231) to call `handleStartDownload` with modified download options (`downloadLinks: false`, `downloadLinksFullScraping: false`) instead of returning early

## 2. Verification

- [x] 2.1 Verify the build compiles without errors (`npm run build` or equivalent)
- [ ] 2.2 Manually test: In server mode with "Scrape linked pages" enabled, press Stop during first-page scrolling and confirm that main page assets are uploaded, the session finalizes, and the zip downloads
- [ ] 2.3 Manually test: In local mode with "Scrape linked pages" enabled, press Stop during first-page scrolling and confirm a zip is created from main page assets without linked pages
- [ ] 2.4 Verify that Stop during linked-page scraping still works correctly (unchanged behavior)
