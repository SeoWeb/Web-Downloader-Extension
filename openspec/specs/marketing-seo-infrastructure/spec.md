# Marketing SEO Infrastructure Specification

## Purpose

Site-wide technical SEO for PagePocket's public site: metadata foundations, crawlability (sitemap/robots), social preview images, structured data, icons/manifest, privacy-friendly analytics, and the performance budget that keeps marketing routes fast. Applies to every indexable route served from the `(marketing)` group on pagepocket.app.

## Requirements

### Requirement: Metadata Foundation

The marketing site SHALL define `metadataBase` (`https://pagepocket.app`), a root title default plus `%s · PagePocket` template, and per-route canonical URLs.

#### Scenario: Canonical URLs

- **WHEN** any marketing, use-case, compare, docs, changelog, about, or blog page is rendered
- **THEN** its `<head>` MUST include `<link rel="canonical">` with the production absolute URL of that route
- **AND** the page `<title>` MUST follow the template (or default on `/`)

### Requirement: Sitemap And Robots

The site SHALL expose a build-generated sitemap and robots rules.

#### Scenario: Sitemap

- **WHEN** a crawler fetches `/sitemap.xml`
- **THEN** it MUST receive every indexable route: all marketing pages, use-case pages, compare pages, docs pages, changelog, about, and every published blog post, each with a lastModified date

#### Scenario: Robots

- **WHEN** a crawler fetches `/robots.txt`
- **THEN** it MUST allow `/` and all marketing/content routes, MUST disallow `/app`, `/s/`, `/api/`, and MUST include the absolute sitemap URL

### Requirement: Social Preview Images

Every indexable route SHALL reference an OG and Twitter image that resolves.

#### Scenario: OG images resolve

- **WHEN** any marketing route's `og:image` URL is fetched
- **THEN** it MUST return HTTP 200 with an image content type (1200×630)
- **AND** blog post OG images MUST be generated per post (title-aware) rather than shared placeholders

### Requirement: Structured Data

The site SHALL emit JSON-LD structured data appropriate to each page type.

#### Scenario: Site-wide

- **WHEN** the landing page renders
- **THEN** it MUST include `SoftwareApplication` and `Organization` JSON-LD objects naming PagePocket, with the Chrome Web Store and GitHub URLs as identifiers/links

#### Scenario: Per page type

- **WHEN** a page renders an FAQ section
- **THEN** it MUST include `FAQPage` JSON-LD matching the visible questions
- **WHEN** a blog post renders
- **THEN** it MUST include `BlogPosting` JSON-LD with headline, datePublished, author, and canonical URL
- **WHEN** a nested page (use-case, compare, docs, blog post) renders
- **THEN** it MUST include `BreadcrumbList` JSON-LD
- **AND** `aggregateRating` MUST NOT be emitted unless backed by real, citable data

### Requirement: Icons And Manifest

The site SHALL ship a complete icon set and web manifest.

#### Scenario: Manifest and icons

- **WHEN** the site is loaded
- **THEN** a web manifest MUST resolve naming PagePocket with icons from `public/icons/`
- **AND** favicon, Apple touch icon, and OG-safe icon variants MUST resolve via metadata (no 404s)

### Requirement: Privacy-Friendly Analytics

The site SHALL measure traffic without trackers or cookies.

#### Scenario: Analytics

- **WHEN** any marketing page loads
- **THEN** the ONLY measurement script MUST be the cookieless Cloudflare Web Analytics beacon
- **AND** the CSP for non-API paths MUST be extended just enough to allow the beacon host, leaving `/api/*` headers and the sandboxed share viewer unchanged
- **AND** no new cookies MAY be set for marketing visitors

### Requirement: Performance Budget For New Routes

All new marketing/content routes SHALL meet the existing performance budget.

#### Scenario: Budget check

- **WHEN** `pnpm build` runs
- **THEN** every route under `/use-cases`, `/compare`, `/blog`, `/docs`, `/changelog`, `/about` MUST report first-load JS under 120 KB gzipped
- **AND** CI MUST fail if any route exceeds the budget
