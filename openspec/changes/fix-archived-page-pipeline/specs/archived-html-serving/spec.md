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

### Requirement: Credential-less archived asset access

CORS echoing alone cannot unblock the sandboxed viewer: CORS-mode subresource loads cannot send cookies at all (per the fetch spec), so cookie-only authentication on the archived-file route fails those loads permanently. The BFF SHALL therefore mint a signed asset token — `payload_b64url + "." + mac_b64url`, where payload is compact JSON `{"p": page_id, "u": user_id, "e": exp_epoch}` base64url-encoded without padding and `mac` is HMAC-SHA256 keyed by the DEDICATED `ASSET_TOKEN_SECRET` (never `JWT_SECRET`) over the encoded payload string — with bucketed expiry `e = (floor(now/TTL) + 2) * TTL`, TTL defaulting to 604800 seconds. When the archived-file proxy serves a `text/html` file response to an authenticated viewer, it SHALL inject that token as a PATH segment into the document's archived-file URLs — `/api/pp/archive/pages/{page_id}/f/X` becomes `/api/pp/archive/pages/{page_id}/f/at/{token}/X` for BOTH absolute app URLs and root-relative ones — rewriting only THIS page's URLs, idempotently (never `/f/at/at/`), and never modifying css/js/img bytes (relative references inside CSS inherit the token segment as part of the path). Rewritten HTML responses SHALL carry `Cache-Control: private, no-cache` so each view picks up the current bucket's token. The gateway SHALL accept cookie OR a valid token on the archive page-file route and SHALL reject expired, foreign-page, foreign-user, or bad-MAC tokens like a missing credential. With `ASSET_TOKEN_SECRET` unset or empty the feature SHALL be OFF: HTML is served byte-identical to the un-rewritten behavior. Tokens SHALL NOT be logged.

#### Scenario: Sandboxed viewer subresources load without cookies

- **WHEN** the logged-in viewer opens an archived page in the sandboxed iframe and the feature is on
- **THEN** the served HTML's `/api/pp/archive/pages/{page_id}/f/` asset URLs carry `/f/at/{token}/`, the document response carries `Cache-Control: private, no-cache`, and the css/js/img/font subresources load without cookies (CORS-mode included)
- **AND** non-HTML asset bytes are served unchanged and the same view within the bucket mints the same token

#### Scenario: Invalid, expired, or foreign tokens are rejected

- **WHEN** the archive page-file route receives a request whose token fails HMAC verification, whose `e` has passed, or whose (p, u) does not match the requested page and owner
- **THEN** the request is rejected with 401 exactly like a missing credential
- **AND** a request carrying the owner's valid session cookie is unaffected by token validation

#### Scenario: Feature off serves HTML unchanged

- **WHEN** `ASSET_TOKEN_SECRET` is unset or empty
- **THEN** no token is minted, the served HTML is byte-identical to the un-rewritten behavior, and its cache-control handling is unchanged
