## 1. Foundation & trust fixes (Phase 0 quick wins)

- [x] 1.1 Read Next 16 docs (`node_modules/next/dist/docs/`) for metadata, sitemap.ts, robots.ts, ImageResponse, MDX — note API drift in the change thread
- [x] 1.2 Root metadata: `metadataBase`, title default + `%s · PagePocket` template, root description, OG/Twitter defaults in `src/app/layout.tsx`
- [x] 1.3 Fix the three 404 OG references: real OG images for `/`, `/features`, `/pricing` (1200×630, ImageResponse or real product imagery)
- [x] 1.4 `app/sitemap.ts` + `app/robots.ts` (allow marketing, disallow `/app`, `/s/`, `/api/`; sitemap reference)
- [x] 1.5 Icons + manifest: favicon set, apple-icon, `manifest` via metadata (reuse `public/icons/*.png`)
- [x] 1.6 Write `/privacy` and `/terms` (real content: what is stored — account data, archived pages in R2, auth cookies; third parties: Cloudflare, R2; no analytics cookies) — user reviews wording before ship
- [x] 1.7 Footer: GitHub → `https://github.com/SeoWeb/Web-Downloader-Extension`, install link → Chrome Web Store URL; remove placeholder links; verify zero 404s
- [x] 1.8 Remove fabricated testimonials section from `/`
- [x] 1.9 Screenshot pipeline: Playwright capture script (seeded demo content, both themes) → `public/screenshots/`; capture the core set (library, viewer, share, search, extension popup)

## 2. Core pages (Phase 1)

- [x] 2.1 Shared marketing components: `Section`, `Container`, `PageHero`, `JsonLd`, `ComparisonTable`, `FaqList` (JSON-LD-integrated), type scale + spacing rhythm in tokens
- [x] 2.2 Home rework per modified Landing Page requirement: hero → annotated screenshot → pain → 3-step → bento → persona strip → comparison table → 8+ item FAQ → CTA
- [x] 2.3 Features page: real screenshot per capability, TOC anchors, kill all placeholders
- [x] 2.4 Pricing page: Free + Pro $2/mo cards with honest quota table (verify actual quotas from gateway/monolith config), optional factual Perma.cc price context
- [x] 2.5 Nav/footer polish: use-case + blog links, consistent CTAs, dark-mode parity check

## 3. Content routes (Phase 1)

- [x] 3.1 Four use-case pages (researchers, journalists, developers, archivists): persona hero, ≥3 workflows with screenshots, ≥3 FAQ items + FAQPage JSON-LD, CTA, cross-links
- [x] 3.2 Three comparison pages (singlefile, wayback, perma-cc): accurate feature tables, "when the competitor wins" section, CTA
- [x] 3.3 BreadcrumbList JSON-LD on all nested routes

## 4. Blog, docs, changelog, about (Phase 2)

- [x] 4.1 MDX infrastructure: `@next/mdx`, `content/blog/*.mdx` + `content/docs/*.mdx` + `content/changelog/*.md`, frontmatter schema (title, description, date, author, slug), RSC rendering
- [x] 4.2 `/blog` index + `/blog/[slug]` (date, author, reading time, prev/next, per-post `ImageResponse` OG, BlogPosting JSON-LD, sitemap inclusion)
- [x] 4.3 Write the 5 launch articles per the approved keyword set
- [x] 4.4 `/docs` index + 6 pages (getting started, saving, collections, search, sharing, troubleshooting)
- [x] 4.5 `/changelog` from release notes (newest-first) — confirm source format with user
- [x] 4.6 `/about`: project story, repo link, store link

## 5. SEO & measurement (Phase 3)

- [x] 5.1 Full JSON-LD pass: SoftwareApplication + Organization site-wide; FAQPage on FAQ-bearing pages; verify against Rich Results Test
- [x] 5.2 Cloudflare Web Analytics: beacon snippet + narrow CSP addition (non-API paths only); confirm no cookies added; confirm share viewer unaffected
- [x] 5.3 Keyword map doc (`openspec/changes/professional-marketing-site/keyword-map.md`): route → primary/secondary keywords, for future content iterations
- [x] 5.4 Handoff notes for user: Search Console verification, store listing rename, nginx root-vs-app split decision

## 6. Store description rebrand

- [x] 6.1 Rewrite `description/en.md` as PagePocket (remove "Web Page Downloader" branding and "100% local processing / no accounts"; add cloud library, search, sharing; repo + persona sections)
- [x] 6.2 Mechanical pass over all other `description/*.md` locales: brand name fix + local-processing claim removal (note full re-translation as follow-up)

## 7. QA & ship

- [x] 7.1 Performance budget: size-limit entries for every new route; `pnpm build` all green under 120 KB
- [x] 7.2 Link sweep: automated check that every internal link + footer link resolves (no 404s)
- [x] 7.3 A11y pass (contrast AA, headings order, focus states) + dark-mode pass on every new page
- [x] 7.4 Claim verification checklist against the honesty policy (no fabricated numbers/quotes anywhere)
- [x] 7.5 `openspec validate professional-marketing-site` clean; CI green; push → `deploy-frontend`
- [x] 7.6 Post-deploy verification: OG debuggers show real previews, `/sitemap.xml` + `/robots.txt` live, analytics beacon firing, Lighthouse SEO ≥ 95 on `/`
