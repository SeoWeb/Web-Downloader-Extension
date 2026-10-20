## MODIFIED Requirements

### Requirement: Landing Page

The frontend SHALL expose `/` as an unauthenticated landing page positioning PagePocket as "your private Wayback Machine" for professionals whose work depends on pages outliving the web.

#### Scenario: Structure

- **WHEN** an unauthenticated visitor opens `/`
- **THEN** the page MUST render, in order: hero with outcome-led headline + subhead + signup CTA + secondary CTA, a real product screenshot with annotations, a pain-recognition section (link rot, tab overload, unsearchable bookmarks), a three-step how-it-works with real captures, a feature bento (Cloud Save, Full-Text Search, Clean Viewer, Collections, Shareable Links), a persona strip linking the four use-case pages, an honest comparison table (PagePocket vs bookmarks vs local-only tools vs public archives), an FAQ of at least eight items, a call-to-action band, and a footer
- **AND** the page MUST be a React Server Component cacheable at the edge with no per-request gateway calls
- **AND** the page MUST NOT contain fabricated testimonials or invented metrics

#### Scenario: Authenticated visitor

- **WHEN** an already-authenticated visitor opens `/`
- **THEN** the page MUST still render (no redirect) but the nav "Sign in" CTA MUST be replaced with "Open dashboard" pointing at `/app`

### Requirement: Pricing Page

The frontend SHALL expose `/pricing` presenting the Free and Pro plans with honest quotas.

#### Scenario: Plan cards

- **WHEN** a visitor opens `/pricing`
- **THEN** two plan cards MUST render: Free (with its real page and storage quotas) and Pro ($2/mo billed yearly, $24/yr, with its real quotas)
- **AND** the Free CTA MUST link to `/register`, and the Pro CTA MUST link to `/register` (upgrade happens in-app; no disabled placeholder tiers)
- **AND** the page MAY include a factual price-context comparison with institutional archive services, with a link to their public pricing

### Requirement: Features Page

The frontend SHALL expose `/features` with a long-form breakdown of each key capability, each evidenced by a real product screenshot.

#### Scenario: Content

- **WHEN** a visitor opens `/features`
- **THEN** the page MUST have a table of contents linking to five anchors: Cloud Save, Clean Page Viewer, Collections & Organization, Full-Text Search, Shareable Links
- **AND** each anchor section MUST include a descriptive paragraph and a real product screenshot (no placeholder elements)

## ADDED Requirements

### Requirement: Trust Links

The marketing shell SHALL link only real, resolvable destinations.

#### Scenario: Footer destinations

- **WHEN** any marketing page renders its footer
- **THEN** the GitHub link MUST point to `https://github.com/SeoWeb/Web-Downloader-Extension`
- **AND** the install link MUST point to the Chrome Web Store listing (`https://chromewebstore.google.com/detail/web-page-downloader/aeojmgngnebhbjpncamiplkimkbnmpmk`)
- **AND** `/privacy` and `/terms` MUST exist and render real content
- **AND** no footer or header link MAY return 404
