## ADDED Requirements

### Requirement: Login Page
The frontend SHALL expose a `/login` route that authenticates users against the gateway's `POST /api/v1/auth/login`.

#### Scenario: Successful login
- **WHEN** the user submits valid `email` + `password`
- **THEN** the client MUST POST to the Next.js Route Handler `/api/session`, which proxies to the gateway `POST /api/v1/auth/login`
- **AND** on 200, the Route Handler MUST set `pp_access` and `pp_refresh` as httpOnly, Secure, SameSite=Lax cookies scoped to `COOKIE_DOMAIN`
- **AND** the page MUST redirect to the `redirect` query param (validated as same-origin) or `/app`

#### Scenario: Invalid credentials
- **WHEN** the gateway returns 401
- **THEN** the login form MUST display an inline "Invalid email or password" error in the appropriate language
- **AND** MUST NOT distinguish wrong-email from wrong-password

#### Scenario: Rate-limited
- **WHEN** the gateway returns 429 with `Retry-After`
- **THEN** the form MUST show "Too many attempts — try again in N seconds" and disable submit until the countdown ends

### Requirement: Register Page
The frontend SHALL expose a `/register` route that calls `POST /api/v1/auth/register` and auto-logs-in the new user.

#### Scenario: Successful registration
- **WHEN** the user submits a unique email, a password ≥ 8 characters, and a name
- **THEN** the Route Handler MUST proxy to the gateway and set the returned tokens as cookies
- **AND** the page MUST redirect to `/app/onboarding` (which MAY be the dashboard with a one-time welcome banner)

#### Scenario: Email already in use
- **WHEN** the gateway returns 409
- **THEN** the form MUST display "An account with this email already exists" with a link to `/login?email=<prefilled>`

#### Scenario: Weak password
- **WHEN** the user types a password
- **THEN** the form MUST show a client-side strength indicator and MUST NOT allow submission until ≥ 8 characters
- **AND** server-side validation remains authoritative (the form MUST still display any 400 error from the gateway)

### Requirement: Logout
The authenticated topbar SHALL expose a "Log out" action that calls a Next.js Route Handler to clear session cookies and call the gateway's `POST /api/v1/auth/logout`.

#### Scenario: Successful logout
- **WHEN** the user clicks "Log out"
- **THEN** the client MUST POST to `/api/session/logout`
- **AND** the Route Handler MUST call the gateway's logout RPC then clear `pp_access` and `pp_refresh` cookies
- **AND** the browser MUST be redirected to `/`

### Requirement: Silent Token Refresh
The frontend SHALL automatically refresh expired access tokens using the stored refresh token, without user interaction.

#### Scenario: 401 on authenticated request
- **WHEN** any authenticated API request returns 401
- **THEN** the API client MUST acquire a module-level single-flight lock and POST to `/api/session/refresh`
- **AND** the Route Handler MUST call the gateway's `POST /api/v1/auth/refresh` with the `pp_refresh` cookie
- **AND** on success, new tokens MUST be written back to cookies and the original request MUST be retried exactly once
- **AND** if refresh itself returns 401 or fails, the user MUST be signed out (cookies cleared) and redirected to `/login`

#### Scenario: Concurrent 401s collapse into one refresh
- **WHEN** N concurrent API requests receive 401 within the same tick
- **THEN** exactly one refresh request MUST be in flight; the remaining N-1 requests MUST await the same promise and retry with the refreshed token once it resolves

### Requirement: Cookie-Only Token Storage
Access and refresh tokens SHALL be stored only in httpOnly cookies; the browser JavaScript MUST NOT have access to raw token values.

#### Scenario: No client-side storage
- **WHEN** the frontend is loaded
- **THEN** `localStorage`, `sessionStorage`, and non-httpOnly cookies MUST NOT contain `pp_access` or `pp_refresh` values
- **AND** component state MUST NOT hold token strings beyond the immediate request scope

#### Scenario: Same-origin API proxy
- **WHEN** the browser needs to call the gateway
- **THEN** requests MUST go through Next.js Route Handlers at `/api/pp/*` that attach the cookie's access token on the server side and forward to the gateway
- **AND** the gateway's base URL MUST NOT be directly callable from the browser for authenticated routes
