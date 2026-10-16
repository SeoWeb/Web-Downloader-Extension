# PagePocket Frontend Auth Specification

## Purpose

Authentication UX and session handling in the Next.js frontend: login/register/logout pages, cookie-only token storage, and single-flight silent token refresh through the /api/pp proxy.

## Requirements

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
The frontend SHALL automatically refresh expired access tokens using the stored refresh token through a single refresh primitive — the `/api/pp` route handler's single-flight refresh block — with full error handling, and SHALL globally handle 401 responses so the UI never continues in a broken authenticated state.

#### Scenario: 401 on authenticated request
- **WHEN** any authenticated API request returns 401
- **THEN** the API client MUST acquire a module-level single-flight lock and trigger the refresh primitive
- **AND** the `/api/pp` refresh block MUST call the gateway's `POST /api/v1/auth/refresh` with the `pp_refresh` cookie
- **AND** on success, new tokens MUST be written back to cookies and the original request MUST be retried exactly once
- **AND** if refresh returns 401, the user MUST be signed out (cookies cleared) and redirected to `/login`

#### Scenario: Refresh failures are handled, never raw-500
- **WHEN** the gateway refresh call throws a network error, returns a non-JSON body, or fails with 503
- **THEN** the `/api/pp` refresh block MUST catch the error and return a definite 503/401 to the caller (single-flight waiters are never poisoned by an unhandled exception)

#### Scenario: Empty refresh cookie never persisted
- **WHEN** the gateway returns a payload whose refresh token is missing or empty
- **THEN** the route handler MUST NOT write an empty `pp_refresh` cookie (no `?? ""` fallback) and MUST treat the session as refresh-failed

#### Scenario: Concurrent 401s collapse into one refresh
- **WHEN** N concurrent API requests receive 401 within the same tick
- **THEN** exactly one refresh request MUST be in flight; the remaining N-1 requests MUST await the same promise and retry with the refreshed token once it resolves

#### Scenario: Global 401 handling clears the session
- **WHEN** any query/mutation receives a definitive 401 (refresh failed or absent)
- **THEN** a global handler (e.g. `QueryCache.onError`) MUST clear the session state and redirect to `/login` (the dashboard never remains mounted as a zombie)

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

### Requirement: Session Cookie Lifetime Outlives the Access Token
The `pp_access` cookie SHALL be issued with a 30-day lifetime (transport only — the gateway still enforces the 1 h value TTL on every use), and the request proxy SHALL treat the presence of `pp_refresh` as pass-worthy so a valid refresh token prevents hard logouts and RSC deep-link 404s.

#### Scenario: Expired access token with live refresh stays signed in
- **WHEN** a user returns after 2 hours (access token expired, `pp_refresh` still present and valid) and requests an authenticated page
- **THEN** the proxy guard MUST NOT hard-redirect to `/login`; it must allow the request so the refresh primitive can rotate the access token

#### Scenario: Deep-link RSC render works
- **WHEN** a user opens `/app/pages/<id>` directly with an expired `pp_access` but a valid `pp_refresh`
- **THEN** the server render MUST complete after refresh (never a `notFound()` 404 caused solely by cookie expiry)

#### Scenario: Cookie expiry removed
- **WHEN** `pp_access` is set by any auth route handler
- **THEN** its `maxAge` MUST be ~30 days (matching `pp_refresh`), not the 1 h access-token TTL

### Requirement: Dead Refresh Route Removal
The unused `/api/session/refresh` route SHALL be deleted with zero remaining references, eliminating the unmanaged refresh path whose invocation trips refresh-token reuse detection and forces a whole-family logout.

#### Scenario: Route absent
- **WHEN** the frontend source tree is searched for `/api/session/refresh`
- **THEN** neither the route file (`app/api/session/refresh/route.ts`) nor any caller MUST exist

#### Scenario: Single refresh primitive only
- **WHEN** any frontend code needs to rotate tokens
- **THEN** it MUST use the `/api/pp` refresh primitive (no second, racing refresh path exists)

### Requirement: Redirect Validation Rejects Backslash Bypass
The login redirect validator SHALL reject any `redirect` value containing a backslash (and already-rejected `//`-prefixed, scheme-bearing, or non-`/`-leading values), falling back to `/app`.

#### Scenario: Backslash open-redirect blocked
- **WHEN** the login page is opened with `?redirect=/\evil.com`
- **THEN** the validator MUST NOT treat the value as a same-origin path and MUST fall back to `/app`

#### Scenario: Normal redirects still work
- **WHEN** the login page is opened with `?redirect=%2Fapp%2Fpages%2Fabc`
- **THEN** the user MUST land on `/app/pages/abc` after login
