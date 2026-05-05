## ADDED Requirements

### Requirement: Authenticated Page Viewer Route
The frontend SHALL expose `/app/pages/[pageId]` that renders a saved page for its owner.

#### Scenario: Successful view
- **WHEN** an authenticated user visits `/app/pages/abc`
- **THEN** the page MUST call `GET /api/v1/archive/pages/abc/view` via the authenticated proxy and receive `{ url, expires_at }`
- **AND** MUST render a header (page title, source URL, archived-at, Back/Share/Delete actions) plus a full-viewport `<iframe src={url} sandbox="allow-same-origin allow-popups allow-forms">`
- **AND** the iframe `sandbox` MUST NOT include `allow-top-navigation` or `allow-scripts-same-origin` escalations

#### Scenario: Not owned
- **WHEN** the gateway returns 404 (cross-user or non-existent `pageId`)
- **THEN** the viewer MUST render a "Page not found" state with a Back button to `/app`

#### Scenario: Presigned URL refresh before expiry
- **WHEN** the iframe remains mounted and `expires_at` is within 5 minutes of the current time
- **THEN** the app MUST refetch the viewer endpoint in the background and update the iframe `src`
- **AND** the iframe's scroll position SHOULD be preserved where technically possible (same-origin optimisations only; best-effort)

### Requirement: Iframe Sandboxing
The saved-page iframe SHALL be sandboxed so untrusted archived HTML cannot access the parent frame or navigate the top window.

#### Scenario: Sandbox attributes
- **WHEN** the viewer renders the iframe
- **THEN** `sandbox` MUST be set to `allow-same-origin allow-popups allow-forms`
- **AND** the iframe MUST NOT have `allowfullscreen`, `allow-scripts-same-origin`, or `allow-top-navigation`

#### Scenario: Top-frame navigation blocked
- **WHEN** an archived page attempts `window.top.location = '...'`
- **THEN** the browser's sandbox enforcement MUST prevent navigation of the parent frame
- **AND** the app MUST NOT install any message listener that would emulate top-navigation on the iframe's behalf

### Requirement: Minimal Chrome
The viewer chrome SHALL be minimal and non-overlapping with the archived content.

#### Scenario: Sticky header
- **WHEN** the viewer renders
- **THEN** a 48-px sticky header MUST occupy the top of the viewport with the page title on the left and action buttons on the right
- **AND** the iframe MUST fill the remaining viewport with `100dvh - 48px`

#### Scenario: Source URL link
- **WHEN** the user clicks the source URL in the header
- **THEN** the browser MUST open the original URL in a new tab (`target="_blank" rel="noopener noreferrer"`)

### Requirement: Keyboard Shortcuts
The viewer SHALL support keyboard shortcuts: `Esc` to return to the dashboard, `S` to open the share dialog, `Del` (with confirm) to delete.

#### Scenario: Escape to dashboard
- **WHEN** the user presses `Esc`
- **THEN** the router MUST navigate back to `/app` (or the referrer if same-origin and under `/app`)
