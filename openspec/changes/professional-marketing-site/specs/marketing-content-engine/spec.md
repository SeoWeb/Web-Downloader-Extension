## ADDED Requirements

### Requirement: Persona Landing Pages

The site SHALL expose four persona/use-case pages targeting distinct professional keyword clusters.

#### Scenario: Use-case page renders

- **WHEN** a visitor opens `/use-cases/researchers` (or `/journalists`, `/developers`, `/archivists`)
- **THEN** the page MUST render: a persona-specific hero, at least three concrete workflow use cases with real screenshots, an FAQ of at least three items with `FAQPage` JSON-LD, a signup CTA, and cross-links to the other three persona pages

### Requirement: Comparison Pages

The site SHALL expose three honest competitor comparison pages.

#### Scenario: Fair comparison

- **WHEN** a visitor opens `/compare/singlefile` (or `/wayback`, `/perma-cc`)
- **THEN** the page MUST render an accurate feature comparison table, an explicit "when this competitor is the better choice" section, and a PagePocket CTA
- **AND** competitor facts MUST be verifiable from the competitor's own public materials; no disparagement or fabricated claims

### Requirement: Blog

The site SHALL expose an MDX-based blog with an index and per-post pages.

#### Scenario: Launch content

- **WHEN** the change ships
- **THEN** `/blog` MUST list at least five published posts: the "save a web page forever" pillar, "Wayback Machine alternatives", "SingleFile vs cloud archive", the journalist source-archiving guide, and the "cite pages that won't rot" guide

#### Scenario: Post page

- **WHEN** a visitor opens `/blog/[slug]`
- **THEN** the page MUST render title, publish date, author, reading time, the article body, a generated OG image, `BlogPosting` JSON-LD, and navigation to other posts
- **AND** the post MUST appear in the sitemap

### Requirement: Docs, Changelog, About

The site SHALL expose documentation, a changelog, and an about page.

#### Scenario: Docs

- **WHEN** a visitor opens `/docs`
- **THEN** a docs index MUST link pages covering: getting started, saving pages, collections, full-text search, sharing, and troubleshooting
- **AND** each docs page MUST render from MDX with a canonical URL and be in the sitemap

#### Scenario: Changelog

- **WHEN** a visitor opens `/changelog`
- **THEN** entries MUST render newest-first with dates and product improvements, sourced from existing release notes

#### Scenario: About

- **WHEN** a visitor opens `/about`
- **THEN** the page MUST describe the project, link the open-source repository (`https://github.com/SeoWeb/Web-Downloader-Extension`), and link the Chrome Web Store listing

### Requirement: Content Honesty Policy

All public content SHALL be verifiable.

#### Scenario: No fabricated proof

- **WHEN** any marketing page renders
- **THEN** it MUST NOT contain fabricated testimonials, invented metrics, or unverifiable claims
- **AND** social proof MUST be limited to verifiable sources: real screenshots, the Chrome Web Store listing, and the GitHub repository

#### Scenario: Link hygiene

- **WHEN** the change ships
- **THEN** every header/footer link MUST resolve (no 404s), including `/privacy`, `/terms`, the GitHub repo, and the Chrome Web Store URL

### Requirement: Store Description Brand Alignment

The Chrome Web Store descriptions SHALL match the product and brand.

#### Scenario: English listing

- **WHEN** `description/en.md` is reviewed
- **THEN** it MUST brand as PagePocket, MUST NOT claim "100% local processing" or "no accounts", MUST describe cloud save, full-text search, and share links accurately, and MUST reference the open-source repository

#### Scenario: Locale propagation

- **WHEN** the English listing is updated
- **THEN** every other `description/*.md` locale MUST at minimum have the brand name corrected and the local-processing/no-accounts claim removed, with a note that full re-translation is a follow-up
