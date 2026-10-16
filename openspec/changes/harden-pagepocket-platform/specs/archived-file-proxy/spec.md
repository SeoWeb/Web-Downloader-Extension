## ADDED Requirements

### Requirement: Private Caching of Cookie-Authenticated Files
The `/api/pp` proxy SHALL force `Cache-Control: private` (preserving any `max-age`) on all archived-file responses, overriding any upstream `public` or `immutable` directive, because the responses are cookie-authenticated and shared caches (Cloudflare) MUST NOT store or reuse them across users.

#### Scenario: Upstream public directive is downgraded
- **WHEN** the gateway responds to a `/api/pp`-proxied file request with `Cache-Control: public, immutable, max-age=31536000`
- **THEN** the response delivered to the browser MUST carry `Cache-Control: private, max-age=31536000` (or equivalent private form)

#### Scenario: No public caching of authenticated files
- **WHEN** any `/api/pp` file response is inspected
- **THEN** its `Cache-Control` MUST contain `private` and MUST NOT contain `public` or `immutable`

### Requirement: Route Allow-List and Traversal Rejection
Both `/api/pp` and `/api/sc` proxies SHALL reject any request whose normalized target path escapes their permitted route families: after URL-decoding and dot-segment normalization, `/api/pp` MUST forward only paths matching `^/api/v1/(archive|library|search|share|auth)/`, and `/api/sc` MUST validate its token segment; violations return HTTP 400 without proxying.

#### Scenario: Encoded dot-dot escape rejected
- **WHEN** a request targets `/api/pp/api/v1/archive/%2e%2e/%2e%2e/docs`
- **THEN** the proxy MUST return HTTP 400 and MUST NOT issue any upstream request

#### Scenario: Prefix escape to non-API route rejected
- **WHEN** a request composes a path that normalizes to `/docs` or `/openapi.json` on the gateway
- **THEN** the proxy MUST reject it with HTTP 400 (the gateway's non-`/api/v1` surface is unreachable through the proxies)

#### Scenario: Legitimate route passes
- **WHEN** a request targets `/api/pp/api/v1/archive/pages/abc/assets/index.html` with a valid session
- **THEN** the proxy MUST forward it to the same normalized gateway path

### Requirement: Streaming Body Handling
Both proxies SHALL stream request and response bodies between browser and gateway without buffering whole files in memory: `/api/sc` MUST NOT materialize the upstream response via `arrayBuffer()`, and request bodies (including `DELETE` bodies) MUST be forwarded.

#### Scenario: Large archive streamed through /api/sc
- **WHEN** a share viewer downloads a 256 MB archived ZIP via `/api/sc/{token}/{path}`
- **THEN** the route handler MUST stream the bytes to the client without holding the whole file in route-handler memory (no OOM at container limits)

#### Scenario: DELETE with body is forwarded
- **WHEN** a `DELETE /api/pp/api/v1/library/collections/x` request carries a JSON body
- **THEN** the body MUST reach the gateway intact

### Requirement: Conditional and Media Header Passthrough
The `/api/pp` proxy SHALL forward `Range`, `Accept`, `If-None-Match`, `If-Modified-Since`, and the caller's `Content-Type` headers upstream, and SHALL pass the upstream response's `Content-Type` through unchanged for file responses (never hardcoding `application/json`).

#### Scenario: Range request honored end-to-end
- **WHEN** the browser sends `Range: bytes=1000-1999` for an archived asset through `/api/pp`
- **THEN** the upstream request MUST include the `Range` header and the client MUST receive the upstream's `206 Partial Content` response untouched

#### Scenario: File content type preserved
- **WHEN** the gateway serves an archived HTML file with `Content-Type: text/html; charset=utf-8` through `/api/pp`
- **THEN** the browser MUST receive `text/html; charset=utf-8` (not a hardcoded `application/json`)

#### Scenario: Revalidation headers forwarded
- **WHEN** the browser sends `If-None-Match` on an asset request
- **THEN** the upstream MUST receive it and a `304` response MUST pass back unchanged

### Requirement: Sole Archived-Content Delivery Path
The sandboxed proxy routes SHALL be the only delivery path for archived content: gateway REST responses (`GET /api/v1/archive/pages/{id}/view`, `GET /api/v1/share/public/{token}`) MUST NOT include presigned R2 URLs, and archived HTML/assets MUST be reachable only through the four sandboxed serving routes with CSP enforced.

#### Scenario: No presigned URL in REST responses
- **WHEN** any REST client fetches a page view or public share payload
- **THEN** the JSON response MUST NOT contain a `url` or `signed_url` field pointing at R2

#### Scenario: Archived HTML reachable only via sandboxed routes
- **WHEN** an archived page's HTML is requested
- **THEN** it MUST be served through a sandboxed proxy route (CSP + sandbox applied), never through a directly shareable presigned object URL
