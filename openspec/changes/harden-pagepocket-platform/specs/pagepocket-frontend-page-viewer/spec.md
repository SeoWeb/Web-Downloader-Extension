## MODIFIED Requirements

### Requirement: Authenticated Page Viewer Route
The frontend SHALL expose `/app/pages/[pageId]` that renders a saved page for its owner, fetching the page by id (never by scanning a page-size-limited list) and rendering archived content through the sandboxed proxy path — never an off-origin presigned URL.

#### Scenario: Successful view
- **WHEN** an authenticated user visits `/app/pages/abc`
- **THEN** the page MUST fetch that page by id via the authenticated proxy (`GET /api/v1/archive/pages/abc` metadata + sandboxed asset route for content)
- **AND** MUST render a header (page title, source URL, archived-at, Back/Share/Delete actions) plus a full-viewport `<iframe>` whose `src` is a first-party sandboxed proxy path
- **AND** the iframe `sandbox` MUST NOT include `allow-top-navigation` or `allow-scripts-same-origin` escalations

#### Scenario: Not owned
- **WHEN** the gateway returns 404 (cross-user or non-existent `pageId`)
- **THEN** the viewer MUST render a "Page not found" state with a Back button to `/app`
- **AND** the 404 MUST be determined by the id-based fetch, so pages beyond the newest 50 are still viewable (no `page_size: 50` + `.find()` lookup)

#### Scenario: Iframe sandbox attributes
- **WHEN** the viewer renders the content iframe
- **THEN** `sandbox` MUST be set to `allow-popups allow-forms` (origin-isolated — archived pages are attacker-controlled; `allow-same-origin` MUST be absent, matching the shell-level CSP sandbox on the proxy response)
- **AND** the iframe `src` MUST be same-origin (the proxy path), never a presigned R2 URL

#### Scenario: Top-frame navigation blocked
- **WHEN** an archived page attempts `window.top.location = '...'`
- **THEN** the browser's sandbox enforcement MUST prevent navigation of the parent frame
- **AND** the app MUST NOT install any message listener that would emulate top-navigation on the iframe's behalf

## ADDED Requirements

### Requirement: Delete Flow Error Handling
The viewer's delete action SHALL check the delete response status and only mutate UI state on confirmed success; failures MUST surface an error state while the page remains viewable.

#### Scenario: Delete succeeds
- **WHEN** the user confirms deletion and the gateway returns a success status
- **THEN** the app MUST navigate back to `/app` with the page removed from subsequent lists

#### Scenario: Delete fails
- **WHEN** the delete request returns 5xx (or a network error occurs)
- **THEN** the viewer MUST show a visible error (toast/error state) and MUST NOT navigate away or remove the page from the UI as if it were deleted
