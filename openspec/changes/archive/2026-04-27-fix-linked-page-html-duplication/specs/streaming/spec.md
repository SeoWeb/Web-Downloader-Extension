## MODIFIED Requirements

### Requirement: Incremental Assembly Download

The system SHALL support downloading with pre-assembled incremental HTML content. In server mode, scroll-streamed HTML chunks SHALL NOT include `pageUrl` so the server groups them under the `"main"` page job rather than creating a separate job keyed by URL hash.

#### Scenario: Incremental assembly download with valid job

- GIVEN a valid assembly job ID
- AND the incremental merge finalizes successfully
- WHEN the incremental download is executed
- THEN the assembled HTML is used as the index file
- AND remaining resources are processed normally
- AND the ZIP is generated and downloaded

#### Scenario: Incremental assembly finalization failure

- GIVEN an assembly job ID whose finalization fails
- WHEN the incremental download is executed
- THEN an error is thrown with the finalization error
- AND the download is aborted

#### Scenario: Main page scroll streaming groups under main job

- GIVEN server mode is active and the main page is being scrolled
- WHEN each scroll step uploads an HTML chunk via `SERVER_UPLOAD_HTML_CHUNK`
- THEN the message data SHALL NOT include `pageUrl`
- AND the server assigns `page_url_hash = "main"` for all scroll-streamed chunks
- AND all scroll chunks coalesce into the same `"main"` job as the download-phase chunk

#### Scenario: No phantom linked page from scroll streaming

- GIVEN server mode is active and the main page was scrolled 5 times
- WHEN the session is assembled
- THEN there SHALL be exactly one result for `page_url_hash = "main"`
- AND no additional linked page result SHALL be generated from the main page URL
- AND the ZIP output SHALL NOT contain a duplicate of the main page in the `pages/` directory
