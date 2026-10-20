## Context

PagePocket's public site lives inside the app frontend: `pagepocket/frontend/src/app/(marketing)/` (Next.js 16.2.4, React 19, Tailwind v4 CSS-first, shadcn "base-nova" on `@base-ui/react`, lucide icons, Geist fonts, oklch teal/orange tokens, next-themes dark mode). Both `pagepocket.app` and `app.pagepocket.app` serve this app today. Deploys: push to `pagepocket` → CI → `deploy-frontend` (pnpm build, restart `:3000`). Hard constraints: Next 16 has breaking API changes vs training data (read `node_modules/next/dist/docs/` before coding; middleware is `src/proxy.ts` exporting `proxy`); 120 KB/route first-load JS budget enforced via size-limit; `/s/[token]`, `/api/sc/*`, `/api/pp/*`, auth routes, and `(app)` are off-limits.

Evidence base (prod, 2026-10-19): footer `/privacy` + `/terms` 404; footer GitHub links → `github.com/anomalyco/opencode` (placeholder); 3 OG image URLs 404 (no og-\*.png in repo); no sitemap/robots/canonical/metadataBase/JSON-LD; features page contains literal "Screenshot placeholder" divs; testimonials fabricated; `description/en.md` brands as "Web Page Downloader" and claims "100% local processing… no accounts" contradicting the cloud product. Chrome Web Store listing: `https://chromewebstore.google.com/detail/web-page-downloader/aeojmgngnebhbjpncamiplkimkbnmpmk` (still named "Web Page Downloader"). Open-source repo: `https://github.com/SeoWeb/Web-Downloader-Extension`.

## Goals / Non-Goals

- **Goals**: professional design & structure; marketing that converts professionals (researchers, journalists, developers, archivists); SEO surface that can actually rank (technical layer + content engine); honest proof everywhere; store description alignment.
- **Non-Goals**: billing/Stripe (Pro CTA → `/register`; upgrades in-app), Team tier, i18n of the website (store locales only get mechanical claim fixes), domain/nginx rearchitecture, CMS, changing any share/auth/app/API behavior.

## Decisions

### D1 · Same app, `(marketing)` group (alternative rejected: separate marketing site)

A standalone site would split deploys, domains, and design systems for zero user-visible gain. The existing `(marketing)` route group is static RSC, budgeted, and deploys via the existing `deploy-frontend` job. `NEXT_PUBLIC_MARKETING_SITE_URL` exists but stays unused for now. Canonicals point at `https://pagepocket.app`.

### D2 · Positioning & messaging (user-decided)

Primary audience: professionals. Positioning: **"Your private Wayback Machine"** — full-fidelity pages, private & under your control, full-text searchable, shareable via link, $2/mo. Value pillars in priority: Fidelity → Privacy/control → Findability → Shareability → Price. Hero copy to be finalized during implementation against this brief; tone: precise, evidence-led, no hype. Anti-claims policy: never state numbers/quotes that aren't real.

### D3 · Proof replaces fabrication (user-decided)

Remove testimonials entirely. Proof sections use: real annotated screenshots, Chrome Web Store link (and rating/review count once confirmed on the listing), GitHub repo link with live star count (plain link — no client-side fetch, keeps budget), honest "how it works" captures. No `aggregateRating` JSON-LD until backed by real store data.

### D4 · Screenshot pipeline (alternative rejected: JSX mockups)

Real captures via a Playwright script (Playwright is already in `frontend/node_modules`) against a real running app with a dedicated demo account, full-page + cropped variants, both themes where relevant, stored in `public/screenshots/`, served via `next/image` with explicit sizes. The script lives in `frontend/scripts/` so screenshots are regenerable as the product evolves. If local-stack seeding is impractical, capture against the production app with a clearly-named demo account (`demo@pagepocket.app`-style) publishing 1–2 clean demo pages.

### D5 · SEO architecture

- Root `layout.tsx`: `metadataBase: https://pagepocket.app`, `title.default` + `title.template "%s · PagePocket"`, root description, OG/Twitter defaults, icons + manifest.
- Per-route `metadata` with `alternates.canonical`.
- `app/sitemap.ts`: enumerates static routes + use-cases + compare + docs + changelog + blog slugs (slugs read from content frontmatter at build time). `app/robots.ts`: allow `/`, disallow `/app`, `/s/`, `/api/`, `Sitemap:` line.
- JSON-LD via a shared `<JsonLd>` component: `SoftwareApplication` + `Organization` (site-wide), `FAQPage` (home, use-cases, docs), `BlogPosting` (posts), `BreadcrumbList` (nested routes).
- OG images: `opengraph-image.tsx` `ImageResponse` routes are acceptable for ALL routes (they satisfy the "must resolve, 1200×630" requirement without binary assets); per-post generated for blog is mandatory.
- Analytics: Cloudflare Web Analytics (cookieless, fits "no tracking" claim, zero infra) — CSP on non-API paths gains the beacon host; no cookies beyond existing auth.

### D6 · Content engine (alternative rejected: headless CMS)

`@next/mdx` with content in-repo: `content/blog/*.mdx`, `content/docs/*.mdx` (frontmatter: title, description, date, author, slug, keywords). Changelog: `content/changelog/*.md`, newest-first. Docs index + 6 pages. RSC rendering keeps the JS budget intact.

**Launch articles (approved set)**:

1. `how-to-save-a-web-page-forever` — pillar: methods compared, PagePocket flow
2. `wayback-machine-alternatives-personal-archiving` — "wayback machine alternative"
3. `singlefile-vs-cloud-archive` — what local-only saving costs you
4. `journalists-archive-sources-link-rot` — evidence workflow, link-rot stats
5. `cite-web-pages-that-wont-rot` — "perma.cc alternative", fair comparison

**Comparison pages**: `/compare/{singlefile,wayback,perma-cc}` — accurate feature tables, explicit "when the competitor is the better choice" section, no disparagement.

**Use-case pages**: `/use-cases/{researchers,journalists,developers,archivists}` — persona pain → workflow with screenshots → FAQ (≥3 items, FAQPage JSON-LD) → CTA; cross-linked.

### D7 · Design system evolution (not a rewrite)

Keep teal `--primary` / orange `--accent-warm`, dark mode, Geist. Add: consistent type scale (display/h1–h4/body/small), section spacing rhythm, shared `Section`/`Container`/`PageHero` marketing components, standardized card/badge/table styles for compare pages. Professional = calm, aligned, real imagery; no animation-heavy hero.

### D8 · Store description rebrand

Rewrite `description/en.md` as PagePocket: fix name, remove "100% local processing / no accounts", add cloud library, search, sharing, the store URL as install link, open-source repo, and professional persona sections (reuse existing good persona copy where accurate). Locales: mechanical pass over all 44 other files replacing brand name and the local-processing claim with localized equivalents of the corrected en.md claims; full re-translation of each locale is explicitly a follow-up.

### D9 · Pricing page (user-decided)

Free (real quotas) + Pro $2/mo billed yearly ($24/yr) with an honest quota table. Optional price-context note ("Perma.cc starts at $10/mo") — factual, linked. No Team card.

## Risks / Trade-offs

- **[Next 16 drift]** → read `node_modules/next/dist/docs/` for metadata/sitemap/robots/ImageResponse APIs before writing code; smoke-test in dev.
- **[Budget regressions from richer pages]** → every new route measured; screenshots via `next/image` (no client JS); MDX in RSC; analytics is an external script (no bundle cost); keep size-limit entries for all new route groups.
- **[CSP change for analytics]** → narrowest possible `script-src` addition for the CF beacon host on non-API paths only; verify no impact on `/api/*` headers or the sandboxed viewer.
- **[SEO results take months]** → quick-wins phase ships first (canonical/sitemap/OG/404 fixes) so crawl health improves immediately; content compounds after.
- **[Store listing rename is store-side]** → website + `description/*.md` land in this change; the actual Chrome Web Store edit is a user action, noted in tasks.
- **[Fabrication risk in marketing copy]** → honesty policy is a spec requirement; implementation review checklist includes claim verification against the product.

## Migration Plan

1. Phase 0 (quick wins) ships independently and immediately improves crawl health and trust: 404 fixes, real links, testimonial removal, metadata foundation, sitemap/robots, real OG images, manifest/icons.
2. Core pages (home/features/pricing) replace existing routes in place — URLs stable, no redirects needed.
3. New sections (use-cases, compare, blog, docs, changelog, about) ship additively; sitemap updates in the same commit.
4. Store copy lands last so the website is live before the listing copy changes.

## Open Questions

- Final hero headline/subhead — pick during implementation against the D2 brief (2–3 candidates, user picks).
- Confirm current store rating/review count before surfacing it as proof.
- Changelog source of truth (existing release notes vs hand-written entries) — confirm format with user at implementation.
