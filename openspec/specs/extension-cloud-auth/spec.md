# Extension Cloud Auth Specification

## Purpose

Extension-side PagePocket authentication: the login/register form, registration and login API calls, automatic token refresh, logout, and session-scoped storage of all auth state (cleared on browser restart by design).

## Requirements

### Requirement: Login form when cloud mode requires authentication

When cloud storage is toggled ON and the user is not authenticated, the extension SHALL display a login/register form in place of the Filter component in the MainContent area.

#### Scenario: Auth form shown when cloud ON and not authenticated

- **GIVEN** cloud storage is toggled ON and no valid auth tokens exist
- **WHEN** the sidepanel loads and no download is in progress
- **THEN** the login/register form is displayed instead of the Filter component

#### Scenario: Filter shown when cloud ON and authenticated

- **GIVEN** cloud storage is toggled ON and valid auth tokens exist
- **WHEN** the sidepanel loads
- **THEN** the Filter component is displayed with the download button

#### Scenario: Filter shown when cloud OFF

- **GIVEN** cloud storage is toggled OFF
- **WHEN** the sidepanel loads
- **THEN** the Filter component is displayed regardless of authentication state

### Requirement: Registration via PagePocket API

The extension SHALL allow users to create a PagePocket account by calling `POST /api/v1/auth/register` with `{email, password, name}`.

#### Scenario: Successful registration

- **GIVEN** the user is on the registration form
- **WHEN** the user submits a valid email, password (8+ characters), and name
- **THEN** the extension calls `POST /api/v1/auth/register` with the credentials
- **AND** receives `{access_token, refresh_token, expires_at, user}`
- **AND** stores the tokens and user data in `chrome.storage.local` under `pagepocket_auth`
- **AND** the auth form is replaced by the Filter component with "Connected" indicator

#### Scenario: Registration with existing email

- **GIVEN** the user submits an email that is already registered
- **WHEN** the API returns 409 ALREADY_EXISTS
- **THEN** the form displays "Email already registered" error message
- **AND** the user remains on the registration form

#### Scenario: Registration with weak password

- **GIVEN** the user submits a password shorter than 8 characters
- **WHEN** the API returns 400 INVALID_ARGUMENT
- **THEN** the form displays "Password must be at least 8 characters" error

### Requirement: Login via PagePocket API

The extension SHALL allow users to authenticate by calling `POST /api/v1/auth/login` with `{email, password}`.

#### Scenario: Successful login

- **GIVEN** the user is on the login form
- **WHEN** the user submits correct email and password
- **THEN** the extension calls `POST /api/v1/auth/login`
- **AND** receives and stores JWT tokens and user data
- **AND** the auth form is replaced by the Filter component with "Connected" indicator

#### Scenario: Invalid credentials

- **GIVEN** the user submits incorrect email or password
- **WHEN** the API returns 401 UNAUTHENTICATED
- **THEN** the form displays "Invalid credentials" error message

### Requirement: Automatic token refresh

The extension SHALL automatically refresh expired access tokens using the stored refresh token when an API call returns 401.

#### Scenario: Token refresh on expired access token

- **GIVEN** the user has valid stored tokens and the access token has expired
- **WHEN** the extension makes an authenticated API call and receives 401
- **THEN** the extension calls `POST /api/v1/auth/refresh` with the stored refresh token
- **AND** stores the new token pair
- **AND** retries the original request with the new access token

#### Scenario: Concurrent 401s share one refresh call

- **GIVEN** multiple API calls return 401 simultaneously
- **WHEN** the refresh logic executes
- **THEN** only one `POST /auth/refresh` call is made
- **AND** all waiting callers receive the new token

#### Scenario: Refresh token expired or revoked

- **GIVEN** the refresh token has expired or been revoked
- **WHEN** the extension attempts to refresh
- **THEN** all stored tokens are cleared from `chrome.storage.local`
- **AND** the authentication state is set to unauthenticated
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

### Requirement: PagePocket API URL from build-time env var

The PagePocket API base URL SHALL be determined at build time via the `VITE_PAGEPOCKET_URL` environment variable. This is separate from the existing `VITE_SERVER_URL` used by the Python microservice client.

#### Scenario: API URL configured via env var

- **GIVEN** `VITE_PAGEPOCKET_URL` is set to `http://localhost:8000`
- **WHEN** the PagePocket client makes an API call
- **THEN** the request is sent to `http://localhost:8000/api/v1/...`

#### Scenario: No PagePocket URL configured

- **GIVEN** `VITE_PAGEPOCKET_URL` is not set
- **WHEN** the extension loads
- **THEN** PagePocket features are completely hidden (no toggle, no auth UI)

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
