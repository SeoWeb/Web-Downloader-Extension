# Launch handoff — professional-marketing-site (owner actions)

Everything that CANNOT be done from the repo: credentials, third-party
dashboards, the Chrome Web Store console, and an nginx decision. Code-side
plumbing for all five items is already shipped. Sections are self-contained;
do them in any order, but §1–§2 are the highest-value minutes-per-rank.

## What shipped in the repo (context for the steps below)

- Task 5.1 — site-wide JSON-LD: `Organization` + `SoftwareApplication`
  rendered by `pagepocket/frontend/src/app/(marketing)/layout.tsx` via the
  shared `<JsonLd>` component (payload builders +
  tests in `pagepocket/frontend/src/components/marketing/site-json-ld.ts`).
  Per-page `FAQPage` / `BlogPosting` / `BreadcrumbList` scripts from earlier
  batches are untouched. No `aggregateRating` (spec forbids until real).
- Task 5.2 — analytics plumbing: the cookieless Cloudflare Web Analytics
  beacon renders in the marketing layout ONLY when
  `NEXT_PUBLIC_CF_BEACON_TOKEN` is set at **build time** (unset → zero
  requests, zero bytes). CSP on non-API paths already allowlists
  `https://static.cloudflareinsights.com` (`next.config.ts`); `/api/*`
  sandbox headers are untouched. Optional var documented (empty default) in
  `pagepocket/frontend/.env.example` and resolved in `src/lib/env.ts`.

---

## 1. Cloudflare Web Analytics (task 5.2 — activate)

The app renders the official beacon
(`<script defer src="https://static.cloudflareinsights.com/beacon.min.js"
data-cf-beacon='{"token": "..."}'>`) as soon as the token exists in the
environment. Dropping the token in is the only remaining step.

1. Cloudflare dashboard → **Analytics & Logs → Web Analytics** → _Add a
   site_ → enter `pagepocket.app`.
2. Choose the **manual JS snippet** path (not the auto-install/proxy
   injection — the frontend is a plain `next start` behind nginx) and copy
   the **token** from the snippet it shows you
   (`data-cf-beacon='{"token": "…"}'`).
3. On the host (`185.213.25.5`), add it to the frontend env file,
   `pagepocket/frontend/.env.production.local`:
   ```
   NEXT_PUBLIC_CF_BEACON_TOKEN=<token>
   ```
   (Same file that already carries `COOKIE_SECRET` etc. Do NOT commit the
   token anywhere in the repo.)
4. **Redeploy the frontend** — the token is read at BUILD time, so a bare
   process restart is NOT enough. Easiest: push to `pagepocket` (or re-run
   `deploy-frontend`); the workflow runs `pnpm build` on the host, which
   picks up the env file. Manual mirror: `cd pagepocket/frontend &&
pnpm build && cp -al .next .next.bak-$(date +%s)` then restart
   `next start` (see `scripts/prod/README.md` §deploy).
5. Verify: _view source_ on `https://pagepocket.app` → search for
   `beacon.min.js` (present only because the token is set); Cloudflare Web
   Analytics should show page views within minutes.

Notes:

- Cookieless by design — Cloudflare Web Analytics sets no cookies and does
  not fingerprint, so **no consent banner is required** and none was added.
  This keeps the "no tracking" product claim intact (spec:
  Privacy-Friendly Analytics).
- The beacon renders only on `(marketing)` routes — never on `/app`, the
  share viewer, or `/api/*`.
- With the token unset the page emits literally nothing for analytics
  (verified: `grep -r cloudflareinsights .next/server/app/*.html` → 0 hits).

## 2. Google Search Console (task 5.4)

1. Open https://search.google.com/search-console → add property.
   Recommended: **Domain property** (`pagepocket.app`) → verification via
   **DNS TXT record** in Cloudflare DNS (GSC shows the TXT value; Cloudflare
   → DNS → Records → Add → Type `TXT`, Name `@`, paste value). The
   URL-prefix property with the `cloudflare` verification string works too
   if you prefer scoping to `https://`.
2. After verification: **Sitemaps → Add** → submit
   `https://pagepocket.app/sitemap.xml`.
   (`app/sitemap.ts` enumerates all marketing/use-case/compare/docs/
   changelog/about/blog-post URLs; `app/robots.ts` already links it.)
3. Useful first-week actions: URL Inspection → _Request indexing_ for
   `https://pagepocket.app` and the pillar post
   `https://pagepocket.app/blog/how-to-save-a-web-page-forever`; then watch
   _Page indexing_ and _Core Web Vitals_ reports.

## 3. Chrome Web Store listing rename to PagePocket (design D8)

The listing (`aeojmgngnebhbjpncamiplkimkbnmpmk`) is still named
"Web Page Downloader" — the rename is store-side only.

1. Open https://chrome.google.com/webstore/devconsole → your item
   (`aeojmgngnebhbjpncamiplkimkbnmpmk`) → **Store listing**.
2. **Item title**: `PagePocket — Your private Wayback Machine` (or plain
   `PagePocket`, if the title + summary length limits prefer it).
3. **Description**: use `description/en.md` (repo root) verbatim — it is
   the corrected, honest copy from this change (PagePocket branding,
   cloud library + search + sharing, no "100% local processing / no
   accounts" claim). The other 44 locale files got the mechanical
   brand/claim pass; full re-translation is an explicit follow-up, so only
   update a locale's store text if you can review the translation.
4. Submit for review. The install link everywhere on the site
   (`chromewebstore.google.com/detail/web-page-downloader/…`) is the
   stable item URL and keeps working after the rename.
5. After the review is live: check the public listing for the real
   rating/review count. Once you can cite it, surface it as proof (design
   D3) — and only then consider adding `aggregateRating` to
   `softwareApplicationJsonLd()` in
   `pagepocket/frontend/src/components/marketing/site-json-ld.ts`
   (deliberately absent today).

## 4. nginx: `pagepocket.app` vs `app.pagepocket.app` (decision needed)

Current state (routing table in `scripts/prod/README.md`): `pagepocket.app`
has an explicit `server_name` block → `127.0.0.1:3000`. `app.pagepocket.app`
reaches the SAME frontend **only via nginx's implicit default-server block**
— it "works by accident". One config mistake in the default vhost would
silently take the app subdomain down.

Pick one:

- **a. Make it explicit (recommended, ~5 lines):** add an
  `server { listen 443 ssl http2; server_name app.pagepocket.app; … }`
  block mirroring the apex block (same certs/`proxy_pass
http://127.0.0.1:3000`). Behavior unchanged; the accident becomes a
  contract.
- **b. Split hosts:** marketing on the apex, app.\* serves only the app.
  ⚠️ All canonicals, `metadataBase`, sitemap and JSON-LD URLs assume
  `https://pagepocket.app` (`MARKETING_SITE_URL` in
  `pagepocket/frontend/src/lib/marketing-routes.ts`). A split therefore
  needs 301s from `app.pagepocket.app` marketing routes to the apex BEFORE
  flipping, and `CORS_ALLOW_ORIGINS` (pagepocket/.env) already lists both
  hosts, so the app itself keeps working either way.
- **c. Keep single-host as-is:** accept the default-server coupling; do
  nothing. Not recommended, but honest option.

Note for any change: the shell already sends
`Strict-Transport-Security: max-age=63072000; includeSubDomains` — HSTS
caches in browsers for 2 years, so keep serving `app.pagepocket.app` (or
redirect it properly) even if it eventually stops being an app host.

## 5. OG / social card validation (post-deploy)

Once this change is deployed, test the home page and the pillar post:

- URLs: `https://pagepocket.app` and
  `https://pagepocket.app/blog/how-to-save-a-web-page-forever`
- Tools:
  - LinkedIn Post Inspector — https://www.linkedin.com/post-inspector/
  - Facebook Sharing Debugger —
    https://developers.facebook.com/tools/debug/ (hit **Scrape again**
    after each deploy; FB caches aggressively)
  - X card validator — post the URL in a draft or use
    https://cards-dev.twitter.com/validator while logged in
- Expect: a 1200×630 OG image (generated per-route via
  `opengraph-image.tsx`; per-post for blog), `og:site_name` PagePocket,
  `twitter:card` `summary_large_image`, titles following
  `%s · PagePocket`.
- If a card shows stale content, re-scrape; everything is generated at
  build time, so a cache-busting re-scrape after deploy is normal.
