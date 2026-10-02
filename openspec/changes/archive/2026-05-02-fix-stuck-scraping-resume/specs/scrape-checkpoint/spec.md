## MODIFIED Requirements

### Requirement: Checkpoint updated with resource URLs after extraction
The system SHALL persist resource URLs to the checkpoint at two points: (1) after main-page resource processing completes (`processImages`, `processAssets`, `processDocuments` settle and filename map is uploaded), and (2) after all resource extraction completes (including linked pages). The first save ensures the checkpoint is populated before linked-page processing, which is the longest-running phase and the most likely point for service worker termination. The second save overwrites with the complete superset including linked-page resources.

#### Scenario: Checkpoint saved after main-page resource processing
- **WHEN** `processImages`, `processAssets`, and `processDocuments` have settled and the filename map has been uploaded
- **THEN** the checkpoint is updated with `resourceUrls` containing all main-page discovered resource metadata (images, assets, documents)
- **AND** each entry includes `url` (original URL), `path` (ZIP path), and `contentType` (MIME type)
- **AND** this occurs BEFORE linked-page processing begins

#### Scenario: Checkpoint overwritten after all resource extraction
- **WHEN** resource extraction completes (after `processImages`, `processAssets`, `processDocuments`, and `processLinks`/linked-page processing settle)
- **THEN** the checkpoint is updated with the complete `resourceUrls` array containing all discovered resource metadata (main page + linked pages)
- **AND** this overwrites the earlier progressive save with a superset

#### Scenario: No main-page resources discovered
- **WHEN** `processImages`, `processAssets`, and `processDocuments` settle but no resources were enqueued
- **THEN** no progressive checkpoint save occurs (the `resourceUrls` array would be empty)
- **AND** the final save after all extraction still runs if linked pages discover resources
