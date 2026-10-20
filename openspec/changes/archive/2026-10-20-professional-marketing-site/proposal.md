## Why

The pipeline (capture → cloud → viewer → share) is now production-solid, but the public site undersells it and actively damages trust: `/privacy` and `/terms` 404 from the footer, GitHub links point at a placeholder repo, testimonials are fabricated, the features page ships literal "Screenshot placeholder" divs, and the SEO surface is near zero (no sitemap, no robots, no canonical, all three OG images 404). Meanwhile the competitive gap is real and unclaimed: SingleFile is local-only, Wayback/archive.today are public and out of your control, Perma.cc is institutionally priced ($10–100+/mo) — nobody owns "private, searchable, shareable personal web archive" at consumer price. This change makes pagepocket.app a professional, competitor-beating marketing site aimed at the professional segment (researchers, journalists, developers, archivists).

## What Changes

**Trust & proof (defects fixed)**

- Real `/privacy` and `/terms` pages (footer currently 404s both)
- Footer GitHub links → `github.com/SeoWeb/Web-Downloader-Extension` (project is open-source); Chrome Web Store link → `https://chromewebstore.google.com/detail/web-page-downloader/aeojmgngnebhbjpncamiplkimkbnmpmk`
- Remove fabricated testimonials; replace with verifiable proof (store listing, GitHub stars, real annotated product screenshots)
- Replace the JSX `ProductMockup` and all placeholder divs with real product screenshots

**Structure & marketing (user-approved decisions)**

- Home reworked around the positioning "Your private Wayback Machine": outcome-led hero, how-it-works with real captures, persona strip, honest comparison table, expanded FAQ
- Features page rebuilt with a real screenshot per capability
- Pricing simplified to Free + Pro ($2/mo billed yearly, $24/yr) with an honest quota table — no Team tier until it exists
- NEW use-case (SEO landing) pages: `/use-cases/researchers`, `/use-cases/journalists`, `/use-cases/developers`, `/use-cases/archivists`
- NEW comparison pages: `/compare/singlefile`, `/compare/wayback`, `/compare/perma-cc` with honest feature tables
- NEW `/blog` (MDX) launching with 5 keyword-targeted articles, `/docs` (getting started, saving, collections, search, sharing, troubleshooting), `/changelog`, `/about`

**SEO infrastructure**

- `metadataBase` + title templates + canonicals; `sitemap.ts`; `robots.ts` (index marketing/blog/docs, noindex `/app`, `/s/*`, `/api`)
- Real OG/Twitter images (static for core routes, `ImageResponse`-generated for blog posts)
- JSON-LD: `SoftwareApplication`, `Organization`, `FAQPage`, `BlogPosting`, `BreadcrumbList` — no fabricated `aggregateRating`
- Web app manifest + full icon set; privacy-friendly analytics (Cloudflare Web Analytics, cookieless)

**Store presence**

- Rebrand `description/en.md` (and key claims across the 45 locale files) from "Web Page Downloader" to PagePocket; remove the contradictory "100% local processing, no accounts" claim (the product has accounts + cloud); align all claims with actual behavior; add store URL + open-source repo as proof points

**Explicitly out of scope / untouched**: `/s/[token]` share flow, `/api/sc/*`, auth routes, `/api/pp/*` proxy and its CORS allowlist, the `(app)` dashboard, backend services, billing (Pro CTAs point to `/register`; upgrade happens in-app).

## Capabilities

### New Capabilities

- `marketing-seo-infrastructure`: Site-wide technical SEO — metadata templates/canonicals, sitemap, robots, OG/Twitter images, structured data, icons/manifest, analytics — and performance-budget enforcement for all new routes.
- `marketing-content-engine`: Content routes and governance — blog (MDX + 5 launch articles), docs, changelog, about, persona/use-case pages, comparison pages, content honesty policy, store-description rebrand.

### Modified Capabilities

- `pagepocket-frontend-marketing`: Landing page restructured (hero, real proof, persona strip, comparison table, FAQ); pricing requirement updated from "Free/$5/Team with disabled CTAs" to "Free + Pro $2/mo" matching shipped reality; features requirement updated from "screenshot placeholder" to real screenshots per capability; new trust-links requirement (no dead footer links).

## Impact

- **Code**: `pagepocket/frontend/**` only — `(marketing)` route group, new shared marketing components, `src/app/layout.tsx` (metadata), `next.config.ts` (CSP allowance for the analytics beacon), `public/` assets (screenshots, icons, OG images). New dependencies: MDX support (`@next/mdx`), built-in `ImageResponse` for OG generation (no extra dep on Next 16).
- **Specs**: `openspec/specs/pagepocket-frontend-marketing/spec.md` modified; two new capability specs created.
- **Store copy**: `description/en.md` rewritten; mechanical name/claim fixes across `description/*.md` locales.
- **Deploy**: unchanged pipeline (push to `pagepocket` → CI → `deploy-frontend` restarts `:3000`). No backend, gateway, monolith, or extension (`src/**`) changes.
- **Constraints honored**: Next 16 API drift (read `node_modules/next/dist/docs/` before coding); 120 KB/route first-load JS budget preserved and extended to all new routes; dark-mode parity; `/s/*` and API routing untouched.
- **User follow-ups outside this change**: Chrome Web Store listing rename (store-side), Search Console verification (DNS/host side), nginx root-vs-app domain split (host-side, currently "works by accident").
