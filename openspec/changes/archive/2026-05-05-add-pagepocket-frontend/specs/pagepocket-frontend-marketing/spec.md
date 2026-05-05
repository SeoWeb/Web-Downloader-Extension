## ADDED Requirements

### Requirement: Landing Page
The frontend SHALL expose `/` as an unauthenticated landing page highlighting PagePocket's core value.

#### Scenario: Structure
- **WHEN** an unauthenticated visitor opens `/`
- **THEN** the page MUST render, in order: hero with headline + subhead + "Install extension" + "Sign up free" CTAs, a three-column feature grid covering Cloud Save, Clean Viewer, and Search, a secondary feature section covering Collections and Shareable Links, a call-to-action band, and a footer
- **AND** the page MUST be a React Server Component cacheable at the edge with no per-request gateway calls

#### Scenario: Authenticated visitor
- **WHEN** an already-authenticated visitor opens `/`
- **THEN** the page MUST still render (no redirect) but the nav "Sign in" CTA MUST be replaced with "Open dashboard" pointing at `/app`

### Requirement: Pricing Page
The frontend SHALL expose `/pricing` presenting the Free, Pro, and Team plans.

#### Scenario: Plan cards
- **WHEN** a visitor opens `/pricing`
- **THEN** three plan cards MUST render with: plan name, monthly price ("Free", "$5/mo", "Contact us"), the quota numbers (50 pages/month + 500 MB; 99999 pages + 10 GB; 99999 pages + 50 GB), a feature list, and a CTA
- **AND** the Free CTA MUST link to `/register`; Pro and Team CTAs MUST be disabled with "Coming soon" and a small note "Billing launches Q3" (since this change does not include Stripe)

### Requirement: Features Page
The frontend SHALL expose `/features` with a long-form breakdown of each key capability.

#### Scenario: Content
- **WHEN** a visitor opens `/features`
- **THEN** the page MUST have a table of contents linking to five anchors: Cloud Save, Clean Page Viewer, Collections & Organization, Full-Text Search, Shareable Links
- **AND** each anchor section MUST include a descriptive paragraph and a simple illustration or screenshot placeholder

### Requirement: SEO Metadata
Marketing pages SHALL set stable `title`, `description`, and OpenGraph metadata via Next.js `generateMetadata`.

#### Scenario: Per-page metadata
- **WHEN** any marketing page is rendered
- **THEN** its `<head>` MUST include `<title>`, `<meta name="description">`, `<meta property="og:title">`, `<meta property="og:description">`, `<meta property="og:image">` (absolute URL), and `<meta name="twitter:card" content="summary_large_image">`

### Requirement: Performance Budget
Every marketing route SHALL ship under 120 KB of gzipped first-load JavaScript.

#### Scenario: Bundle size check
- **WHEN** `pnpm build` runs
- **THEN** the Next.js build output for `/`, `/pricing`, `/features` MUST each report first-load JS under 120 KB
- **AND** CI MUST fail if any route exceeds the budget (enforced via `next build` output parsing or a size-limit tool)
