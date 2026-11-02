## ADDED Requirements

### Requirement: Keep me signed in opt-in

The login and registration forms SHALL offer a "Keep me signed in on this device" checkbox that is pre-checked by default. The checkbox state SHALL control the persistence mode of the authentication performed with it: checked stores the session for browser restarts, unchecked keeps the existing session-only behavior.

#### Scenario: Checkbox is pre-checked on login and registration forms

- **WHEN** the login or registration form is displayed
- **THEN** the "Keep me signed in on this device" checkbox is visible and pre-checked

#### Scenario: Unticked login restores session-only behavior

- **GIVEN** the user unticks "Keep me signed in on this device"
- **WHEN** the user logs in successfully
- **THEN** no PagePocket auth state is written to `chrome.storage.local`
- **AND** all auth state lives in `chrome.storage.session` only

#### Scenario: Choice applies to registration

- **GIVEN** the user registers a new account with "Keep me signed in on this device" checked
- **WHEN** registration succeeds
- **THEN** the refresh token, user record, and cloud binding are persisted to `chrome.storage.local` exactly as for a checked login

## MODIFIED Requirements

### Requirement: Auth state persisted across sessions

PagePocket authentication state SHALL be stored in `chrome.storage.session` by default: it survives service-worker restarts within a browser session but is cleared when the browser closes. When the user opts in via "Keep me signed in on this device" (pre-checked), the refresh token, user record, and cloud binding SHALL additionally be persisted to `chrome.storage.local`, so the session survives browser restarts; the access token and its expiry SHALL remain in `chrome.storage.session` only. The password SHALL never be written to either storage area.

#### Scenario: Tokens survive service worker restart

- **GIVEN** the user was authenticated when the service worker was killed
- **WHEN** the service worker restarts and the sidepanel opens
- **THEN** the tokens are loaded from `chrome.storage.session`
- **AND** the user remains authenticated

#### Scenario: Browser restart with keep-signed-in off clears auth state

- **GIVEN** the user logged in with "Keep me signed in on this device" unticked
- **WHEN** the browser is closed and reopened
- **THEN** `chrome.storage.session` is empty and the extension shows the login/register form
- **AND** no PagePocket tokens remain in `chrome.storage.local`

#### Scenario: Browser restart with keep-signed-in on restores the session

- **GIVEN** the user logged in with "Keep me signed in on this device" checked
- **WHEN** the browser is closed and reopened and the sidepanel loads
- **THEN** the extension loads the refresh token and user record from `chrome.storage.local`
- **AND** refreshes the access token via `POST /api/v1/auth/refresh` before any authenticated call
- **AND** the user remains authenticated without re-entering credentials

#### Scenario: Password is never persisted

- **WHEN** a login, registration, token refresh, or Google sign-in persists authentication state
- **THEN** neither `chrome.storage.session` nor `chrome.storage.local` contains the user's password

### Requirement: Single storage location for PagePocket auth state

All PagePocket authentication state SHALL be read from and written to `chrome.storage.session` through the PagePocket client's storage layer, which is the single writer for auth state. The access token and expiry SHALL live in `chrome.storage.session` only. The refresh token and user record SHALL additionally be mirrored to `chrome.storage.local` when keep-signed-in is active. When keep-signed-in is not active, registration, login, token refresh, and Google sign-in flows SHALL NOT write auth data to `chrome.storage.local` and SHALL remove any previously persisted copies.

#### Scenario: Login with keep-signed-in persists only the refresh token on disk

- **WHEN** a login or registration succeeds with keep-signed-in active
- **THEN** the token pair and user data are written to `chrome.storage.session`
- **AND** only the refresh token, user record, and cloud binding are written to `chrome.storage.local`
- **AND** `chrome.storage.local` contains no access token

#### Scenario: Login without keep-signed-in stores only in session storage

- **WHEN** a login or registration succeeds with keep-signed-in inactive
- **THEN** the token pair and user data are written to `chrome.storage.session`
- **AND** `chrome.storage.local` contains no PagePocket auth keys

#### Scenario: Refresh rotation updates the persisted copy

- **GIVEN** keep-signed-in is active
- **WHEN** the refresh flow rotates the refresh token
- **THEN** the new refresh token replaces the old one in `chrome.storage.session` and in `chrome.storage.local`

#### Scenario: Logout and refresh-failure clear both storage areas

- **WHEN** the user logs out or a refresh attempt finds the refresh token expired/revoked
- **THEN** all stored auth data is cleared from `chrome.storage.session`
- **AND** any persisted refresh token, user record, and cloud binding are removed from `chrome.storage.local`
- **AND** the login/register form is shown

### Requirement: Logout

The extension SHALL allow users to sign out by calling `POST /api/v1/auth/logout` and clearing stored tokens from both storage areas.

#### Scenario: Successful logout

- **GIVEN** the user is authenticated
- **WHEN** the user clicks "Sign Out"
- **THEN** the extension calls `POST /api/v1/auth/logout` with the current access token
- **AND** clears all stored tokens and user data from `chrome.storage.session`
- **AND** removes any keep-signed-in persisted refresh token, user record, and cloud binding from `chrome.storage.local`
- **AND** the authentication state changes to unauthenticated
- **AND** the login/register form is shown

#### Scenario: Logout with keep-signed-in active wipes the persisted session

- **GIVEN** the user logged in with "Keep me signed in on this device" checked
- **WHEN** the user signs out
- **THEN** `chrome.storage.local` contains no PagePocket auth keys afterwards
- **AND** closing and reopening the browser shows the login/register form
