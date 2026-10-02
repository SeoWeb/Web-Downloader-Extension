## MODIFIED Requirements

### Requirement: Server-Mode Parallel Asset Processing

In server mode, the system SHALL process independent asset categories (images, CSS/JS, documents) concurrently instead of sequentially. Images, CSS/JS assets, and documents have no dependencies on each other and their uploads can proceed in parallel, subject to the UploadQueue's concurrency limit.

#### Scenario: Parallel image and asset processing
- **GIVEN** server mode is active and the download includes images and CSS/JS assets
- **WHEN** the server-mode download flow begins processing resources
- **THEN** `processImages`, `processAssets`, and `processDocuments` are started concurrently
- **AND** all three categories enqueue uploads into the shared UploadQueue simultaneously
- **AND** the UploadQueue manages concurrency across all categories

#### Scenario: Image filename map upload ordering preserved
- **GIVEN** parallel asset processing is active
- **WHEN** the images promise resolves with the `imageFilenameMap`
- **THEN** the filename map is uploaded to the server via `uploadFilenameMap`
- **AND** the CSS/JS and document promises may still be in progress during this upload

#### Scenario: Error in one category does not block others
- **GIVEN** parallel asset processing is active and image processing fails
- **WHEN** the images promise rejects
- **THEN** CSS/JS and document processing continue to completion
- **AND** the overall download reports the error after all promises settle

### Requirement: Adaptive Assembly Polling

The system SHALL use adaptive polling intervals when waiting for server-side assembly completion, instead of a fixed interval. Faster assemblies benefit from shorter intervals, while longer assemblies reduce unnecessary HTTP requests.

#### Scenario: Fast assembly gets quick polling
- **GIVEN** assembly polling has just started (elapsed < 6 seconds)
- **WHEN** the client polls for assembly status
- **THEN** the poll interval is 1 second

#### Scenario: Normal assembly gets moderate polling
- **GIVEN** assembly has been running for 6-30 seconds
- **WHEN** the client polls for assembly status
- **THEN** the poll interval is 2 seconds

#### Scenario: Long assembly gets slower polling
- **GIVEN** assembly has been running for more than 30 seconds
- **WHEN** the client polls for assembly status
- **THEN** the poll interval is 3 seconds

#### Scenario: Very long assembly gets conservative polling
- **GIVEN** assembly has been running for more than 60 seconds
- **WHEN** the client polls for assembly status
- **THEN** the poll interval is 5 seconds

#### Scenario: Assembly timeout unchanged
- **GIVEN** adaptive polling is in use
- **WHEN** the total elapsed time exceeds 5 minutes
- **THEN** an `AssemblyTimeoutError` is thrown regardless of poll interval
