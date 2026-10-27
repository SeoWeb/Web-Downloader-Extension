## ADDED Requirements

### Requirement: Bounded download waits

Every wait that gates download finalization SHALL be bounded: it either carries a timeout that releases the wait with a failure, or its unblock is contractually guaranteed elsewhere (memory-pressure gating that must resume). The parallel asset-category wait over images, CSS/JS assets, and documents SHALL carry a safety bound sized from the remaining workload so a stalled category cannot keep the download from finalizing indefinitely. When the bound fires, the pipeline SHALL proceed to finalization and report the stalled category as failed; a rejected images promise remains a hard error.

#### Scenario: Stalled asset category cannot hang finalization

- **GIVEN** one asset category's promise never settles (for example the request queue is stalled)
- **WHEN** the safety bound elapses
- **THEN** the wait is released and the download proceeds to finalization
- **AND** the stalled category is reported as failed instead of being awaited forever

#### Scenario: Bound does not interrupt healthy downloads

- **GIVEN** all three categories are progressing, even if slowly (large download, many resources)
- **WHEN** the wait is bounded from the remaining resource count with a generous cap
- **THEN** a normally completing download is not cut off by the bound

#### Scenario: No finalization-gating wait is unbounded

- **WHEN** the download pipeline awaits a stage whose completion gates finalization
- **THEN** the await either has a timeout or depends on a contractually guaranteed unblock (such as memory-pressure resume)

### Requirement: HTML chunk counter advances on success only

The per-tab HTML chunk index used by the streaming paths SHALL advance only after the corresponding `uploadHtmlChunk` call resolves successfully. A failed chunk upload (including one whose retries are exhausted) SHALL leave the counter unchanged. `hasStreamedHtmlChunks()` SHALL report true only when at least one chunk actually reached the server. The main page's final HTML SHALL be uploaded as chunk 0 exactly once per session: either by a successful streaming upload at index 0, or by the download pipeline's initialization upload when nothing streamed — it SHALL NOT be skipped because a failed upload advanced the counter.

#### Scenario: Failed first chunk keeps the counter at zero

- **GIVEN** scrolling streams the first chunk via `SCROLL_AND_EXTRACT_DIFF` and the upload fails with its retry budget exhausted
- **WHEN** the download reaches the main-page HTML upload step
- **THEN** the chunk counter is still 0 and `hasStreamedHtmlChunks()` returns false
- **AND** the final HTML is uploaded as chunk 0 with `pageType "main"`, so the finalized archive always contains the main page

#### Scenario: Successful chunk advances the counter

- **WHEN** a streaming chunk upload resolves successfully
- **THEN** the counter advances monotonically to the next index (server "next index" semantics)

#### Scenario: Main-page chunk 0 is uploaded exactly once

- **GIVEN** at least one streaming chunk was uploaded successfully for the session
- **WHEN** the download finalizes
- **THEN** the initialization upload is skipped (unchanged skip logic) and the server holds exactly one chunk-0 for the main page
