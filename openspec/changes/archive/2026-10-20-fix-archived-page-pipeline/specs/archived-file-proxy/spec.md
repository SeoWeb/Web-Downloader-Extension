## MODIFIED Requirements

### Requirement: Route Allow-List and Traversal Rejection

Both `/api/pp` and `/api/sc` proxies SHALL reject any request whose normalized target path escapes their permitted route families: after URL-decoding and dot-segment normalization, `/api/pp` MUST forward only composed paths matching `^/api/v1/(archive|library|search|share|auth)(\/|$)` — the match admits each allowed family's bare root (e.g. `POST /api/v1/share` for share-link creation) as well as deeper paths — and `/api/sc` MUST validate its token segment; violations return HTTP 400 without proxying.

#### Scenario: Encoded dot-dot escape rejected

- **WHEN** a request targets `/api/pp/api/v1/archive/%2e%2e/%2e%2e/docs`
- **THEN** the proxy MUST return HTTP 400 and MUST NOT issue any upstream request

#### Scenario: Prefix escape to non-API route rejected

- **WHEN** a request composes a path that normalizes to `/docs` or `/openapi.json` on the gateway
- **THEN** the proxy MUST reject it with HTTP 400 (the gateway's non-`/api/v1` surface is unreachable through the proxies)

#### Scenario: Legitimate route passes

- **WHEN** a request targets `/api/pp/api/v1/archive/pages/abc/assets/index.html` with a valid session
- **THEN** the proxy MUST forward it to the same normalized gateway path

#### Scenario: Bare share-family root passes (share-link creation)

- **WHEN** the share dialog sends `POST /api/pp/share` (composed upstream path `/api/v1/share`) with a valid session
- **THEN** the proxy MUST forward it to the gateway's `POST /api/v1/share` route and return the created link instead of 400 "Proxied route not allowed"

#### Scenario: Bare share-family root query passes (share-link lookup)

- **WHEN** the client sends `GET /api/pp/share?page_id=<id>` (composed upstream path `/api/v1/share`)
- **THEN** the proxy MUST forward it to the gateway's `GET /api/v1/share` route and return the existing link (or the mapped 404) instead of 400
