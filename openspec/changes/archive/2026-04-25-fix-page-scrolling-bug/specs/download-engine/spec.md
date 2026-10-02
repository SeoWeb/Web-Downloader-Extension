## MODIFIED Requirements

### Requirement: Server Mode Download Lifecycle

The system SHALL support a server-mode download lifecycle where HTML chunks are streamed to the server during scrolling, resources are uploaded after download, and ZIP assembly happens on the server. The main-page scroll function SHALL report page height changes and the scroll loop SHALL use height-aware bottom detection.

#### Scenario: Full server mode download flow

- GIVEN server mode is enabled
- WHEN the user initiates a download
- THEN the system creates a server session, scrolls the page sending each HTML chunk to the server, signals scrape-complete when scrolling is done, downloads and uploads resources, uploads the filename map, uploads content text, finalizes the session, waits for assembly, and triggers a download from the server URL
- AND the scroll function reports whether the page height changed during each step via the `heightChanged` flag in `ScrollResult`

#### Scenario: HTML chunk streaming during scroll with height awareness

- GIVEN server mode is enabled and a scroll cycle completes
- WHEN the extension captures the page HTML
- THEN the HTML is immediately uploaded to the server as a chunk
- AND the HTML is not accumulated in browser memory
- AND the `ScrollResult` includes a `heightChanged` flag indicating whether `scrollHeight` changed during the scroll step

#### Scenario: Bottom detection with page growth

- GIVEN the main page is being scrolled and lazy-loaded content causes the page to grow
- WHEN the scroll position reaches the nominal bottom
- THEN the system does NOT stop scrolling if the page height increased compared to the previous step
- AND the system continues scrolling until: at bottom AND height has not changed AND scroll position has not changed for one additional iteration (settle mechanism)

#### Scenario: Layout shift during main page scrolling

- GIVEN the main page is being scrolled and content insertion causes a layout shift
- WHEN the viewport jumps upward (scrollY decreases)
- THEN the scroll function records the jump and continues scrolling
- AND the `heightChanged` flag is set to true in the `ScrollResult`
