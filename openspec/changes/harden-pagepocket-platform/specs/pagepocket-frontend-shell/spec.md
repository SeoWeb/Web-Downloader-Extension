## ADDED Requirements

### Requirement: First-Party Security Headers
The frontend SHALL set baseline security headers for every route via `next.config.ts` (or equivalent server config): `Strict-Transport-Security`, a `frame-ancestors 'none'` CSP directive (or `X-Frame-Options: DENY`), and `poweredByHeader: false`.

#### Scenario: Headers present on responses
- **WHEN** any frontend route is fetched over HTTPS
- **THEN** the response MUST include `Strict-Transport-Security` and a frame-ancestors-none CSP directive (or `X-Frame-Options: DENY`)

#### Scenario: No Next.js powered-by header
- **WHEN** any frontend route response is inspected
- **THEN** `X-Powered-By` MUST NOT be present

### Requirement: Server-Only Environment Guard
`lib/env.ts` SHALL import `server-only` so environment access is impossible from client bundles; any client component importing it fails the build.

#### Scenario: Client import fails the build
- **WHEN** a component with `"use client"` imports `lib/env.ts`
- **THEN** `pnpm build` MUST fail with the `server-only` violation (secret-bearing env values can never reach the browser bundle)

#### Scenario: Server routes keep working
- **WHEN** server-side route handlers import `lib/env.ts`
- **THEN** the build and runtime MUST succeed unchanged

### Requirement: Favicon Privacy
The dashboard SHALL NOT leak archived hostnames to third-party favicon services: page-card favicons MUST be resolved through a first-party path (self-hosted, proxied, or locally cached) with no per-render outbound request to external providers such as `google.com/s2`.

#### Scenario: No third-party favicon lookups
- **WHEN** the dashboard renders cards for archived pages
- **THEN** the browser MUST NOT issue requests to `google.com/s2` (or any external favicon provider) carrying the archived hostname

#### Scenario: Fallback icon without external calls
- **WHEN** no first-party favicon is available for a hostname
- **THEN** the card MUST render a local fallback icon (no external fetch fallback)
