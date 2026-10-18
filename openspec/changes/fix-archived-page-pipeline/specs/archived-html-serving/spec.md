## ADDED Requirements

### Requirement: Opaque-origin viewer CORS on archived-file responses

The sandboxed viewer iframe grants archived documents an opaque origin (the string `null`), so their CORS-mode subresource loads (webfonts always; css/js/img carrying preserved `crossorigin` tags) can never match the gateway's origin allow-list. The two archived-file proxies — `/api/pp/[...path]` when the upstream is the archive page-file route (upstream path containing `/f/`) and `/api/sc/{token}/[...path]` — SHALL, on successful file responses, echo the request's `Origin` header verbatim (including the literal string `null`) into `Access-Control-Allow-Origin`, and SHALL add `Access-Control-Allow-Credentials: true` and `Vary: Origin`. Requests without an `Origin` header SHALL receive no CORS headers, and non-file API responses proxied by either route SHALL never receive `Access-Control-Allow-Origin`. The gateway's CORS allow-list is intentionally unchanged: it never matches `null` and never emits wildcards.

#### Scenario: Sandboxed viewer subresource from origin null is allowed

- **WHEN** the sandboxed viewer iframe (opaque origin `null`) fetches an archived font, stylesheet, script, or image through either file proxy with `Origin: null`
- **THEN** the response carries `Access-Control-Allow-Origin: null`, `Access-Control-Allow-Credentials: true`, and `Vary: Origin`
- **AND** the browser loads the subresource and the archived page renders with its fonts, styles, images, and scripts as stored

#### Scenario: Non-file API responses gain no CORS headers

- **WHEN** a request with an `Origin` header is proxied to a non-file gateway API route (e.g. `POST /api/pp/api/v1/share`)
- **THEN** the response carries no `Access-Control-Allow-Origin` header
- **AND** the BFF's JSON API surface stays browser-internal

#### Scenario: No Origin header gets no CORS headers

- **WHEN** a file is fetched through either proxy without an `Origin` header (e.g. top-level navigation)
- **THEN** the response carries no `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials`, or `Vary: Origin` headers
- **AND** the sandbox header set is unchanged

#### Scenario: Sandbox isolation is not relaxed

- **WHEN** any archived-file response is served with the CORS echo
- **THEN** the `Content-Security-Policy: sandbox allow-popups allow-forms` header set is still present and `allow-same-origin` remains excluded
