## Context

The PagePocket SaaS backend (proposed in the `add-pagepocket-saas-backend` change) exposes every cloud capability as REST under `/api/v1/*` via an API Gateway that JWT-guards all routes except `/api/v1/auth/*` and `/api/v1/share/public/*`. Presigned R2 URLs power the viewer. There is currently no user-facing surface: no login, no dashboard, no viewer, no collections UI, no search UI, no share UI. This change introduces that surface as a Next.js 15 / App Router / TypeScript application.

The product is aimed at students, researchers, and professionals who save web pages for later reading and need to organise and share them. The extension is already a shipping product; the frontend is the "home" for everything captured. The frontend is a first-class dependent of the gateway contract but must stay decoupled from internal gRPC details — the gateway is the boundary.

Key constraints:
- Must not hold JWTs in JavaScript (cookie-only storage via Next.js Route Handlers).
- Must render user-supplied HTML (saved pages) safely — iframe + sandbox, no same-origin scripts trusted.
- Must ship responsive and accessible (WCAG 2.1 AA) from day one.
- Must be deployable to Vercel without vendor lock-in; all Vercel-specific features (edge runtime, ISR) are opt-in, not required.
- Marketing pages must be fast and indexable; app pages need not be SEO-visible.
- No backend changes may be introduced from this change.

## Goals / Non-Goals

**Goals:**
- Turn the backend REST contract into a usable product for the five advertised features: cloud save (viewer), clean page viewer, collections, full-text search, shareable links.
- Keep the JWT out of browser JS by proxying every authenticated API call through Next.js Route Handlers that read an httpOnly cookie.
- Establish a typed API client with runtime Zod validation so schema drift between frontend and gateway is a build/test-time failure, not a runtime "white screen".
- Provide a marketing surface that can be deployed independently of the app (same Next.js app, different route group) for SEO and acquisition.
- Build a design system foundation (tokens, components, dark mode, a11y) that later changes (annotations, AI features, billing) extend without redoing basics.

**Non-Goals:**
- No billing/checkout integration (Stripe); pricing page is copy-only in this change.
- No native mobile apps; responsive web only.
- No server-side transformation of saved page content — viewer is always iframe + presigned URL.
- No CMS for marketing content — copy lives in the repo as TSX.
- No feature flags/experimentation framework beyond env-var gated features.
- No i18n routing in this change (single locale, `en`); the codebase should be i18n-ready (`next-intl` candidate) but localisation is a follow-up.

## Decisions

### D1. Next.js 15 App Router (not Pages Router, not a separate SPA)

Alternatives considered: (a) Pages Router + `getServerSideProps`; (b) a pure SPA (Vite + React Router) talking to the gateway. Chosen App Router because:
- Native support for nested layouts maps directly to our three route groups: `(marketing)`, `(app)`, `(share)`.
- Server Components eliminate shipping code that touches secrets (cookie reads, server-side fetches with bearer tokens) to the browser.
- `loading.tsx`/`error.tsx` give us a zero-boilerplate, per-route UX baseline that a plain SPA would have to reinvent.
- Vercel-friendly without requiring Vercel.

Cost: App Router's mental model (Server vs Client components, caching) is more to learn. Mitigation: explicit conventions ("all auth/data fetching in Server Components or Route Handlers; mutations from client components through Route Handlers").

### D2. JWTs in httpOnly cookies; browser never sees raw tokens

Alternative considered: localStorage or in-memory token storage with manual `Authorization` header. Rejected because:
- Any XSS anywhere in the app (including in a dep we don't control) would leak tokens from localStorage.
- In-memory tokens require a token-refresh bootstrap on every tab, complicating the auth path.

Chosen: `pp_access` (1 h) and `pp_refresh` (30 d) httpOnly Secure SameSite=Lax cookies, written and read only by Next.js Route Handlers. Browser code fetches same-origin `/api/pp/*` routes; the Route Handler attaches the bearer token server-side.

Trade-off: every authenticated call is two hops (browser → Next.js → gateway). For a list or a mutation this is negligible; for huge hot paths we can switch to Edge runtime handlers later. Viewer iframe bypasses this entirely (goes straight to R2 presigned URL).

### D3. `@tanstack/react-query` as the only server-state store

Alternatives: SWR, Redux Toolkit Query, bespoke hooks. Chosen React Query for the mature optimistic-mutation story, `useInfiniteQuery`, and the way it composes with Server Component-provided initial data. No Redux/Zustand needed for server state; local UI state stays in component state or URL.

### D4. Zod schemas at the gateway boundary

Every gateway response is parsed by a Zod schema before it leaves the API client module. This catches backend contract changes at the frontend boundary (surfacing `ApiContractError`) instead of producing `undefined is not a function` in components.

Cost: some duplication of types — gateway has a protobuf schema, frontend has a Zod schema. Accepted because the two systems have different lifecycle needs (protobuf for wire format, Zod for runtime validation at the JS boundary). A future codegen step from `openapi.json` → Zod is plausible but out of scope.

### D5. Viewer always iframes the presigned URL

Alternatives: (a) fetch HTML on the server and stream it through Next.js; (b) inline the HTML with `dangerouslySetInnerHTML`; (c) rewrite HTML at render time.

Chosen: `<iframe src={presigned_url} sandbox="...">`. Rationale:
- Security: saved HTML is untrusted; sandbox is the browser's strongest isolation boundary.
- Correctness: the HTML was stored with relative asset references that R2 is configured to serve directly; inlining would require re-rewriting.
- Performance: zero server-side work; R2 edge-delivered.

Trade-off: iframes break some browser chrome affordances (find-in-page scope, back button to a specific scroll position). Acceptable; the alternative is dangerous.

### D6. Sandbox allowlist kept small

`sandbox="allow-same-origin allow-popups allow-forms"`. Deliberately excludes:
- `allow-top-navigation` — saved pages cannot hijack the parent window.
- `allow-scripts-same-origin` — a saved page's JS cannot access the parent frame's storage.
- `allow-fullscreen` — unneeded.

We allow `allow-same-origin` so the iframe's stylesheets/scripts load correctly under the R2 presigned URL's origin; we allow `allow-popups` so a user clicking an in-page link opens a new tab instead of silently failing. We allow `allow-forms` because some archived pages have inert forms (search boxes) the user may expect to work.

### D7. Route Handlers at `/api/pp/*` as the authenticated proxy

All authenticated browser requests go through `/api/pp/...` (Next.js Route Handlers) which read the cookie and forward to the gateway. Unauthenticated Server Components can call the gateway directly (e.g. `/s/[token]` fetches `share/public/{token}` with no bearer token).

Alternative considered: browser calls the gateway directly with a short-lived bearer header read from a memory token. Rejected (see D2) because it requires keeping tokens in JS.

Trade-off: Route Handlers must be careful not to forward the refresh token; the access token is attached only. Refresh is a dedicated `/api/session/refresh` handler that's the only code path that touches `pp_refresh`.

### D8. Collections drag-and-drop uses `@dnd-kit` (not HTML5 DnD)

HTML5 DnD has poor accessibility (no keyboard story, inconsistent cross-browser behaviour, bad on touch). `@dnd-kit` gives us:
- Pointer-based events that work on mouse, touch, and stylus uniformly.
- First-class keyboard navigation via its `KeyboardSensor`.
- Smooth animations using `@dnd-kit/sortable`.

Cost: extra dependency (~15 KB gz). Worth it for a core feature that must work for keyboard and touch users.

### D9. Search state lives in the URL

`q` and `collection_id` are URL params, not React state. Rationale: the user can share a search result with a colleague, and back/forward navigation works. `page` for the results paginator is local state (resets on query change) since deep-linking to page 7 of a search is unlikely to be valuable and complicates virtualisation.

### D10. Tailwind v4 + shadcn/ui (copy-in components, not a package)

shadcn/ui's philosophy — copy the source into your repo — matches our need to theme deeply and evolve components without waiting on upstream. Tailwind v4 gives us fast builds and CSS custom properties as the token layer, enabling dark mode and future theme variants.

### D11. `sonner` for toasts; `lucide-react` for icons; `react-hook-form`+`zod` for forms

All three are the current community defaults for shadcn-based stacks and have small bundle footprints. No deviation.

### D12. Marketing pages are pure React Server Components, static at build where possible

`/`, `/pricing`, `/features` are cacheable Server Components with no per-request state. `generateStaticParams` and Next.js's default caching give us edge-cached delivery. This protects our perf budget and our SEO without adopting a CMS.

### D13. Share public viewer (`/s/[token]`) is a Server Component that fetches unauthenticated

No React Query, no client state. The page's render path is: Route Handler (or just direct fetch from a Server Component with the runtime `NEXT_PUBLIC_API_BASE_URL`) → gateway `share/public/{token}` → render shell with the returned `{ url, expires_at }`. The iframe's `src` is the presigned URL; if the user idles past expiry, a client-side timer silently reloads the Server Component.

### D14. Testing: Vitest unit + Playwright e2e; no Cypress

Playwright's auto-waits, trace viewer, and native cross-browser support make it a better fit than Cypress for a Next.js App Router app. Unit/component tests use Vitest (fast, Vite-native) + React Testing Library.

## Risks / Trade-offs

- **[Token refresh race on multiple tabs]** → Cookies are shared across tabs; a single-flight lock is per-tab. Two tabs refreshing simultaneously can both succeed — accepted because each refresh returns a new valid pair and refresh-token rotation's reuse-detection on the backend will revoke-all only if a *stale* token is replayed after rotation. We document the small window and accept it.
- **[Iframe sandbox blocks useful features like printing]** → Users wanting to print a saved page can "View source URL" (new tab) or we can add a dedicated "Download original" action later. Not worth weakening the sandbox.
- **[Presigned URL TTL shorter than a long reading session]** → The viewer watches `expires_at` and silently refetches within 5 minutes of expiry (D14 → see spec). For the public share viewer, expiry triggers a full reload via an inline `setTimeout` that reloads the page.
- **[Drag-and-drop on mobile]** → `@dnd-kit` has a pointer sensor that works on touch, but small collection nodes are hard to target with a finger. Mitigation: the per-card "Move" action button opens a searchable combobox — same UX as keyboard, works fine on touch.
- **[Bundle-size regression]** → Marketing page budget (120 KB gz) is enforced via CI; app routes have no hard budget in this change but will be measured. Any component that explodes size (rich-text editor, charts) must be code-split.
- **[Server Component pitfalls — client-only deps bleeding in]** → Enforced by `"use client"` directives at the boundary and a small ESLint rule that bans known-client-only imports from Server Components.
- **[Zod schemas drift from gateway reality]** → Schemas live in `lib/api/schemas/` and are integration-tested against a running Compose stack in CI; drift breaks the e2e suite, not production.
- **[Responsiveness of left-nav tree for large collections]** → With thousands of collections the initial fetch would be heavy. Mitigation: only fetch top-level nodes by default; expand-on-click loads children lazily. For v1 a full load is acceptable (expected N < 200 for 99% of users); the lazy path is a follow-up.
- **[`/app/pages/[pageId]` first render waits on gateway]** → We use streaming with a skeleton until the presigned URL resolves; the iframe loads progressively from R2 once the URL is attached.
- **[No i18n infra in v1]** → All UI strings live as inline English literals; moving to `next-intl` later is a refactor, not a redesign. We colocate strings near components to ease extraction.

## Migration Plan

This change is net-new — nothing is being migrated from. Roll-out order:

1. Scaffold `pagepocket/frontend/` with `pnpm create next-app`; adopt the base tsconfig.
2. Install the core dep set (Tailwind v4, shadcn/ui init, React Query, Zod, react-hook-form, sonner, lucide-react, @dnd-kit).
3. Establish the design system (tokens + 10–15 primitives) before any routes so every later route uses them.
4. Build the auth plumbing (Route Handlers + cookie storage + silent refresh + protected-route guard) before any data route.
5. Build the typed API client + Zod schemas + React Query provider.
6. Build features in this order: dashboard → viewer → collections → search → sharing.
7. Build marketing pages.
8. Wire Playwright e2e against a docker-compose backend stack.
9. Deploy to Vercel (preview env) against a staging gateway; run smoke tests; flip DNS.

Rollback: Vercel's "promote previous deployment" is a one-click revert; the frontend has no database of its own to migrate.

## Open Questions

- **Real-time updates (e.g. new page appears in dashboard while user is viewing it)**: deferred — React Query's `refetchOnWindowFocus` and manual refresh are good enough for v1; WebSocket/SSE is a future change.
- **Thumbnail delivery**: backend change says `thumbnail_key` stays NULL. UI renders a hostname-based placeholder (favicon + first letter). When the backend lands thumbnails, the same `PageCard` component picks them up via a schema addition.
- **Pro/Team plan CTAs**: "Contact us" form vs. mailto link vs. Typeform. Defaulted to "Coming soon" disabled in this change; billing change will fill in.
- **Extension install detection**: would be nice to show "Already installed" on the marketing page; requires a content-script handshake. Deferred.
- **Custom domain for public shares (e.g. share.pagepocket.app/<token>)**: v1 uses `<app-domain>/s/<token>`. A future change may add a CNAME-able domain.
