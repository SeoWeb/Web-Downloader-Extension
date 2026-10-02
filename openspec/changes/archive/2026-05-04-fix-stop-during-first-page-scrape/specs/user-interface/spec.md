## ADDED Requirements

### Requirement: Stop Button Delegates to Scraping Hook
The Stop button in the DownloadStatus component SHALL delegate to an `onStopScraping` callback provided by `useScrapingDownloader` instead of directly calling `setIsScraping(false)`. The callback SHALL send the `SCRAPER_STOP` message to the background, set an internal stop flag, and then set `isScraping` to `false`.

#### Scenario: Stop button calls onStopScraping during first-page scrape
- **GIVEN** the user is viewing the download status during main page scrolling
- **WHEN** the user clicks the Stop button
- **THEN** `onStopScraping()` is called
- **AND** the `SCRAPER_STOP` message is sent to the background
- **AND** the internal stop flag is set in the scraping hook
- **AND** `setIsScraping(false)` is called
- **AND** the `useEffect` in the hook checks the stop flag and does NOT start the download

#### Scenario: Stop button works during linked page scraping (unchanged behavior)
- **GIVEN** the extension is scraping linked pages
- **WHEN** the user clicks the Stop button
- **THEN** `onStopScraping()` is called
- **AND** the `SCRAPER_STOP` message stops the `LinkedPageScraper`
- **AND** `abortActiveDownload` is called
- **AND** the linked page scraper finalizes and creates the ZIP with completed pages

#### Scenario: Stop button visible during all scraping phases
- **GIVEN** the extension is in any scraping phase (main page, linked pages, uploading, assembling)
- **WHEN** the download status component renders
- **THEN** the Stop button is visible and functional
- **AND** clicking it calls `onStopScraping`
