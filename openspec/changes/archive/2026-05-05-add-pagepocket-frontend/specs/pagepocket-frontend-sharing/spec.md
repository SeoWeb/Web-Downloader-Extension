## ADDED Requirements

### Requirement: Share Dialog
The frontend SHALL expose a share dialog reachable from a page card's share icon and the viewer's share button, letting the owner create a share link.

#### Scenario: Open dialog
- **WHEN** the user triggers Share on a page
- **THEN** a modal MUST open with: a "Public link" toggle, an optional expiry picker ("Never" | "24 hours" | "7 days" | "30 days" | custom date), and a primary "Create link" button
- **AND** default state: public ON, expiry "Never"

#### Scenario: Create link
- **WHEN** the user clicks "Create link"
- **THEN** the app MUST call `POST /api/v1/share` with `{ page_id, is_public: true, expires_at: <unix_or_0> }`
- **AND** on success the dialog MUST display the `short_url` with a "Copy" button that writes to the clipboard and shows a "Copied!" toast
- **AND** the view-count display MUST show "0 views"

#### Scenario: Revoke link
- **WHEN** an active share link exists and the user clicks "Revoke"
- **THEN** a confirm step MUST appear; on confirm, `DELETE /api/v1/share/{token}` MUST be called
- **AND** the dialog MUST transition back to the pre-creation state

### Requirement: Active Link Memory
When a page already has an active share link, opening the share dialog SHALL show that link instead of offering to create a new one.

#### Scenario: Existing active link
- **WHEN** the user opens Share on a page that has a non-revoked, non-expired link
- **THEN** the app MUST call `GET /api/v1/share?page_id=<id>` (or the equivalent owner lookup) and render the existing `short_url`, `view_count`, and `expires_at`
- **AND** the primary action MUST be "Copy link", with "Revoke" as a secondary destructive action

### Requirement: Public Share Viewer Route
The frontend SHALL expose `/s/[token]` as an unauthenticated route that renders a publicly shared page.

#### Scenario: Valid public token
- **WHEN** an unauthenticated visitor opens `/s/abc123`
- **THEN** the server component MUST call `GET /api/v1/share/public/abc123` (no bearer token)
- **AND** on `{ url, expires_at }` success, render an iframe pointing at the presigned URL with `sandbox="allow-same-origin allow-popups allow-forms"` (same sandbox policy as the authenticated viewer)
- **AND** the chrome MUST show a "Shared via PagePocket" badge with a link to `/` (no owner name or email)

#### Scenario: Invalid or revoked token
- **WHEN** the public share endpoint returns 404
- **THEN** the page MUST render a "This link has expired or been revoked" state with a link to `/`
- **AND** MUST return HTTP 404 from the Next.js route so search engines don't index the token

#### Scenario: SEO of public shares
- **WHEN** a public share page is rendered
- **THEN** the `<head>` MUST include a `<meta name="robots" content="noindex, nofollow">` by default (can be overridden to `index` in a future change when titles/previews are exposed)

### Requirement: Copy-Link UX
The "Copy link" control SHALL work reliably across browsers, using the Clipboard API with a legacy fallback.

#### Scenario: Modern browser
- **WHEN** `navigator.clipboard.writeText` is available
- **THEN** the button MUST call it and display a "Copied!" toast for 2 seconds

#### Scenario: Clipboard API unavailable
- **WHEN** the API is unavailable (older browsers, permission denied)
- **THEN** the button MUST fall back to selecting a hidden text field + `document.execCommand("copy")` and show the same toast
- **AND** on total failure, show a toast "Could not copy — select and copy manually" with the link text visually selected
