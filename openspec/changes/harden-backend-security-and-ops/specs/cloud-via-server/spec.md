## MODIFIED Requirements

### Requirement: Cloud-mode downloads use server pipeline
When PagePocket cloud mode is enabled and the user is authenticated, the extension SHALL route downloads through the normal server-mode pipeline instead of sending data directly to PagePocket. The extension SHALL establish the cloud identity once via the monolith's binding flow (presenting its PagePocket access token to the authenticated client), and the SERVER SHALL own the identity from then on: per-session `pagepocketUserId` values are only a confirmation of the binding, never the authorization itself.

#### Scenario: Cloud mode enabled
- **WHEN** the PagePocket cloud toggle is ON and valid auth tokens exist in `chrome.storage.session`
- **THEN** the extension SHALL ensure the monolith client is bound to the authenticated PagePocket user (calling the binding flow if not yet bound)
- **AND** create the server session with `pagepocketUserId` matching the binding (or omitted)
- **AND** proceed with the full server-mode download pipeline (HTML chunks, resources, filename maps, linked pages, text content)
- **AND** NOT call `pagepocketClient.ingestPage()` directly

#### Scenario: Binding mismatch fails closed
- **WHEN** the extension's authenticated PagePocket user differs from the monolith client's binding (e.g., the user switched accounts)
- **THEN** the session request is rejected by the server (403)
- **AND** the extension surfaces the error and prompts re-binding rather than silently pushing into the wrong account

#### Scenario: Cloud mode disabled
- **WHEN** the PagePocket cloud toggle is OFF or no auth tokens exist
- **THEN** the extension SHALL create a server session without `pagepocketUserId`
- **AND** proceed with the normal server-mode download and ZIP assembly flow

### Requirement: Cloud session completion handled via server status
When the extension has created a cloud-mode session, it SHALL detect cloud success or failure from the server's session status response and display the appropriate UI. The extension SHALL keep polling within the assembly-timeout envelope (no premature client timeout while the server push is still progressing).

#### Scenario: Cloud push succeeds
- **WHEN** the server session status becomes `ready` and the response includes `cloud_page_id`
- **THEN** the extension SHALL send `status.pagepocketUploadComplete` with the `pageId`
- **AND** send `status.complete` without triggering `chrome.downloads.download`

#### Scenario: Cloud push fails
- **WHEN** the server session status becomes `ready` and `cloud_status` is `"failed"`
- **THEN** the extension SHALL send `status.pagepocketUploadError` with the `cloud_error` message
- **AND** treat it as a failed download

#### Scenario: Long assembly does not time out prematurely
- **WHEN** the server's cloud push takes longer than 5 minutes but is still progressing within the declared envelope
- **THEN** the extension continues polling until the envelope's bound or a terminal status
- **AND** does not report a false failure at the old 5-minute mark

### Requirement: Direct-to-cloud code path removed
The `executeDownloadCloudMode` function and `BlobCollector` class SHALL be removed. The `shouldUseCloudUpload` function SHALL be removed or simplified to only ensure the server-side binding exists.

#### Scenario: No direct PagePocket upload
- **WHEN** a download starts in any mode
- **THEN** the extension SHALL NOT call `pagepocketClient.ingestPage()` during the download pipeline
- **AND** all cloud communication SHALL happen server-side via gRPC
