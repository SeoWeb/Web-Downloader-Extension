## MODIFIED Requirements

### Requirement: Auth state persisted across sessions
PagePocket authentication state SHALL be stored in `chrome.storage.session`: it survives service-worker restarts within a browser session but is intentionally cleared when the browser closes. This is a deliberate privacy choice (consistent with `extension-security-hardening`); re-login after a browser restart is expected, and no PagePocket auth state SHALL be written to `chrome.storage.local`.

#### Scenario: Tokens survive service worker restart
- **GIVEN** the user was authenticated when the service worker was killed
- **WHEN** the service worker restarts and the sidepanel opens
- **THEN** the tokens are loaded from `chrome.storage.session`
- **AND** the user remains authenticated

#### Scenario: Browser restart clears auth state
- **WHEN** the browser is closed and reopened
- **THEN** `chrome.storage.session` is empty and the extension shows the login/register form
- **AND** no PagePocket tokens remain in `chrome.storage.local`

## ADDED Requirements

### Requirement: Single storage location for PagePocket auth state
All PagePocket authentication state — access token, refresh token, expiry, and user record — SHALL be read from and written to `chrome.storage.session` only. Registration, login, token refresh, and logout flows SHALL NOT touch `chrome.storage.local` for auth data.

#### Scenario: Login stores only in session storage
- **WHEN** a login or registration succeeds
- **THEN** the token pair and user data are written to `chrome.storage.session`
- **AND** `chrome.storage.local` contains no PagePocket auth keys

#### Scenario: Logout and refresh-failure clear session storage
- **WHEN** the user logs out or a refresh attempt finds the refresh token expired/revoked
- **THEN** all stored auth data is cleared from `chrome.storage.session`
- **AND** the login/register form is shown
