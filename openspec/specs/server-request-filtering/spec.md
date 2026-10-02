## ADDED Requirements

### Requirement: Bot scan path filtering
The server SHALL reject requests whose path matches a configurable list of known bot-scan patterns with an immediate 404 response, without processing the request through any application logic, authentication, or rate limiting.

#### Scenario: Request to known exploit path
- **WHEN** a request arrives with path `/owa/auth/x.js`
- **THEN** the server responds with 404 status and no response body, and does not log the request at INFO level or above

#### Scenario: Request to WordPress admin probe
- **WHEN** a request arrives with path `/wp-admin/admin-ajax.php`
- **THEN** the server responds with 404 status without reaching application routes

#### Scenario: Request to environment file probe
- **WHEN** a request arrives with path `/.env`
- **THEN** the server responds with 404 status without reaching application routes

#### Scenario: Legitimate extension request passes through
- **WHEN** a request arrives with path `/api/v1/sessions` with a valid API key
- **THEN** the request is processed normally by the application

#### Scenario: Filtered patterns are configurable
- **WHEN** the `filtered_paths` config value is set to `["/custom-block/"]`
- **THEN** requests to `/custom-block/anything` receive 404 and requests to all other paths pass through

### Requirement: Security response headers
The server SHALL add security hardening headers to all responses.

#### Scenario: Server header is removed
- **WHEN** any response is sent
- **THEN** the `Server` response header is not present

#### Scenario: Content type sniffing is prevented
- **WHEN** any response is sent
- **THEN** the response includes `X-Content-Type-Options: nosniff` header

#### Scenario: Frame embedding is denied
- **WHEN** any response is sent
- **THEN** the response includes `X-Frame-Options: DENY` header
