## ADDED Requirements

### Requirement: Page Export Route

The gateway SHALL expose an authenticated streaming endpoint that downloads an archived page as a ZIP.

#### Scenario: Successful download

- **WHEN** an authenticated user requests `GET /api/v1/archive/pages/{page_id}/zip` for a page they own
- **THEN** the response MUST stream `application/zip` bytes from the archive service's export RPC without buffering the whole archive in gateway memory
- **AND** the response MUST include `Content-Disposition: attachment` with a sanitized, filename-safe ZIP name derived from the page title (ASCII fallback `page-{page_id}.zip`)

#### Scenario: Auth and rate limits inherited

- **WHEN** the route is requested
- **THEN** JWT authentication via the existing middleware and the authenticated per-user rate-limit class MUST apply without route-specific configuration

#### Scenario: Error mapping

- **WHEN** the page does not exist or is not owned by the requester
- **THEN** the gateway MUST return 404
- **WHEN** the archive service is unavailable or R2 fails
- **THEN** the gateway MUST return the corresponding classified 5xx, not a partial 200
