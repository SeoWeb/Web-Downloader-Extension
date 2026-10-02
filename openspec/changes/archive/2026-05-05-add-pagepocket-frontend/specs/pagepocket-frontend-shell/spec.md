## ADDED Requirements

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
