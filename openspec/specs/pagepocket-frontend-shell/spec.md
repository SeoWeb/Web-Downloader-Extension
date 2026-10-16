# PagePocket Frontend Shell Specification

## Purpose

The Next.js App Router shell: route groups and layouts, protected-route guarding, global loading/error/empty states, dark mode, and first-party security hygiene.

## Requirements

### Requirement: App Router Scaffold
The frontend SHALL be a Next.js 15 application using the App Router, React 19, and TypeScript with `strict: true`.

#### Scenario: Project scaffolding
- **WHEN** the project is initialised
- **THEN** the repo MUST contain `pagepocket/frontend/app/`, `pagepocket/frontend/components/`, `pagepocket/frontend/lib/`, `pagepocket/frontend/public/`, `pagepocket/frontend/next.config.ts`, `tsconfig.json` (with `strict: true`, `noUncheckedIndexedAccess: true`), and `package.json` with `"type": "module"`
- **AND** `pnpm build` MUST succeed on an empty database

### Requirement: Route Groups
The frontend SHALL partition routes into three route groups with distinct layouts: `(marketing)` for unauthenticated public pages, `(app)` for authenticated user pages, and `(share)` for unauthenticated public share viewer.

#### Scenario: Marketing group
- **WHEN** a user visits `/`, `/pricing`, or `/features`
- **THEN** the `(marketing)` layout MUST render with a marketing nav (logo, pricing, sign-in) and footer
- **AND** the page MUST be a React Server Component cacheable at the edge with no per-request auth lookup

#### Scenario: App group
- **WHEN** a user visits any path under `/app/*`
- **THEN** the `(app)` layout MUST render with the left-nav collection tree, topbar (search, user menu), and main content slot
- **AND** the layout MUST fail-closed: unauthenticated users are redirected to `/login?redirect=<original>`

#### Scenario: Share group
- **WHEN** a user visits `/s/[token]`
- **THEN** the `(share)` layout MUST render with a minimal "Shared via PagePocket" chrome, no auth lookup, and MUST NOT redirect to `/login`

### Requirement: Protected Route Guard
The authenticated layout SHALL redirect unauthenticated users to the login page before rendering any child content, and MUST preserve the original URL for post-login return.

#### Scenario: Unauthenticated access
- **WHEN** a user with no valid session cookie requests `/app/pages/abc`
- **THEN** the server MUST respond with a redirect to `/login?redirect=%2Fapp%2Fpages%2Fabc`
- **AND** no request MUST be issued to the API Gateway on their behalf

#### Scenario: Post-login redirect
- **WHEN** a user successfully logs in with a `redirect` query param
- **THEN** the app MUST navigate to the decoded `redirect` URL
- **AND** the `redirect` MUST be validated to be a same-origin path (leading `/`, no `//` or scheme) — otherwise fallback to `/app`

### Requirement: Global Loading, Error, and Empty States
Every data-driven route SHALL define `loading.tsx` (skeleton) and `error.tsx` (retry) siblings; every list view SHALL render an explicit empty state.

#### Scenario: Skeleton on first load
- **WHEN** a route fetches data on the server or client
- **THEN** a skeleton matching the final layout MUST render via `loading.tsx` until data is available

#### Scenario: Error boundary
- **WHEN** any `app/(app)/...` route throws during render or data fetching
- **THEN** `error.tsx` MUST render with a user-readable message and a "Try again" button that calls `reset()`
- **AND** the raw error message MUST NOT be exposed unless `process.env.NODE_ENV === "development"`

#### Scenario: Empty list
- **WHEN** a list endpoint returns zero items
- **THEN** the UI MUST render an empty state with an icon, a short explanation, and (where applicable) a primary call-to-action (e.g. "Install the extension" on an empty dashboard)

### Requirement: Dark Mode
The application SHALL support light, dark, and system-synced colour schemes, persisted across sessions.

#### Scenario: Toggle
- **WHEN** a user selects a theme from the topbar menu
- **THEN** the app MUST set a `theme` cookie and apply `class="dark"` (or none) on the `<html>` element with no Flash of Unstyled Content on next navigation

#### Scenario: System preference
- **WHEN** a user has never set a theme preference
- **THEN** the app MUST honour `prefers-color-scheme: dark` and MUST NOT set the cookie until the user makes an explicit choice

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
