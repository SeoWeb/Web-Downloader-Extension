## MODIFIED Requirements

### Requirement: Auth tokens live in session storage

By default, PagePocket access/refresh tokens and the server API key SHALL be stored in `chrome.storage.session` (cleared when the browser closes), not `chrome.storage.local`. When the user explicitly opts in via "Keep me signed in on this device", only the refresh token, user record, and cloud binding MAY additionally be persisted to `chrome.storage.local`; the access token SHALL always remain in `chrome.storage.session` only, and the user's password SHALL never be persisted in either storage area.

#### Scenario: Tokens do not survive a browser restart on disk when opted out

- **GIVEN** the user did not opt in to "Keep me signed in on this device"
- **WHEN** the user closes and reopens the browser
- **THEN** no auth tokens remain in `chrome.storage.local`
- **AND** the extension transparently re-registers the API key on first server call

#### Scenario: Opted-in persistence is limited to the refresh token, user record, and cloud binding

- **GIVEN** the user opted in to "Keep me signed in on this device"
- **WHEN** authentication state is persisted for a browser restart
- **THEN** `chrome.storage.local` contains only the refresh token, user record, and cloud binding
- **AND** `chrome.storage.local` contains no access token and no password or password-derived credential

#### Scenario: Access token never touches disk

- **WHEN** any login, registration, token refresh, or Google sign-in stores authentication state
- **THEN** the access token and its expiry are written to `chrome.storage.session` only
