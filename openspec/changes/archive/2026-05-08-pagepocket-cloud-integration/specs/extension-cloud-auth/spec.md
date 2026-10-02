## ADDED Requirements

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
The extension SHALL allow users to sign out by calling `POST /api/v1/auth/logout` and clearing stored tokens.

#### Scenario: Successful logout
- **GIVEN** the user is authenticated
- **WHEN** the user clicks "Sign Out"
- **THEN** the extension calls `POST /api/v1/auth/logout` with the current access token
- **AND** clears all stored tokens and user data from `chrome.storage.local`
- **AND** the authentication state changes to unauthenticated
- **AND** the login/register form is shown

### Requirement: Auth state persisted across sessions
The authentication state SHALL persist across extension restarts via `chrome.storage.local`.

#### Scenario: Tokens survive service worker restart
- **GIVEN** the user was authenticated when the service worker was killed
- **WHEN** the service worker restarts and the sidepanel opens
- **THEN** the tokens are loaded from `chrome.storage.local`
- **AND** the user remains authenticated

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
