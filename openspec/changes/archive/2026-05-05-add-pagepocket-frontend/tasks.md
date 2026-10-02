## 1. Workspace & Tooling

- [x] 1.1 Create `pagepocket/frontend/` with `pnpm create next-app@latest .` selecting: TypeScript, App Router, Tailwind, `src/` dir, import alias `@/*`
- [x] 1.2 Harden `tsconfig.json` with `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`
- [x] 1.3 Add ESLint flat config with `@typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-react-hooks`, and a custom rule banning client-only imports from files without `"use client"`
- [x] 1.4 Add Prettier + `prettier-plugin-tailwindcss`; wire `pnpm format`
- [x] 1.5 Add `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` npm scripts
- [x] 1.6 Add GitHub Actions workflow `.github/workflows/frontend.yml` running the four scripts on PR
- [x] 1.7 Write `pagepocket/frontend/README.md` covering: dev setup, env-var reference, architecture overview, contribution notes

## 2. Design System & Components

- [x] 2.1 Upgrade to Tailwind v4 and define CSS-custom-property tokens in `app/globals.css` per the design-system spec (colours light+dark, radius, spacing, font)
- [x] 2.2 Run `pnpm dlx shadcn@latest init`; select the token scheme so `components/ui/*` pull from our tokens
- [x] 2.3 Generate primitives: Button, Input, Label, Textarea, Select, Combobox, Dialog, DropdownMenu, Tooltip, Tabs, Toggle, Switch, Checkbox, RadioGroup, Avatar, Badge, Card, Skeleton, Table, ContextMenu, Command, Popover (via `pnpm dlx shadcn@latest add ...`)
- [x] 2.4 Add `sonner` for toasts; wrap `<Toaster />` in the root layout
- [x] 2.5 Add `lucide-react`; enforce via lint rule banning other icon libs
- [x] 2.6 Implement `ThemeProvider` and `<ThemeToggle />` honouring `prefers-color-scheme` and persisting the user's choice in `localStorage` via `next-themes`
- [x] 2.7 Write a `components/ui/form.tsx` wrapper integrating `react-hook-form` + `zod` with shared field-error rendering
- [x] 2.8 Write component-level Vitest tests for `Form`, `Toast`, `Dialog` focus trap

## 3. Auth Plumbing

- [x] 3.1 Implement `app/api/session/route.ts` (POST = login, DELETE = logout) that proxies the gateway and sets/clears `pp_access` and `pp_refresh` cookies
- [x] 3.2 Implement `app/api/session/refresh/route.ts` that calls the gateway's `/auth/refresh` using the `pp_refresh` cookie and returns new tokens as cookies; returns 401 on failure
- [x] 3.3 Implement `app/api/session/register/route.ts` for registration
- [x] 3.4 Implement `lib/auth/cookies.ts` helpers: `setAuthCookies(response, { access, refresh, expiresAt })`, `clearAuthCookies(response)`
- [x] 3.5 Implement `lib/auth/server-session.ts` returning the current `user_id` from the JWT payload (decode only; gateway is the verifier)
- [x] 3.6 Implement middleware at `middleware.ts` that matches `/app/*` and redirects unauthenticated requests to `/login?redirect=<pathname>`
- [x] 3.7 Validate `redirect` in the login action: must start with `/`, must not start with `//` or contain a scheme — fallback to `/app`
- [x] 3.8 Wire the logout action in the user-menu dropdown
- [x] 3.9 Unit-test the redirect-validation helper

## 4. Typed API Client

- [x] 4.1 Create `lib/api/schemas/` with Zod schemas for every gateway response: `User`, `AuthResponse`, `PageResponse`, `ListPagesResponse`, `PageContentResponse`, `CollectionResponse`, `ListCollectionsResponse`, `SearchResult`, `SearchResponse`, `ShareLinkResponse`, `ValidateShareResponse`, `StatusResponse`
- [x] 4.2 Create `lib/api/errors.ts` defining `AuthenticationError`, `PermissionError`, `NotFoundError`, `ConflictError`, `QuotaExceededError`, `RateLimitError` (with `retryAfterSeconds`), `ValidationError`, `ApiContractError`, `NetworkError`
- [x] 4.3 Create `lib/api/http.ts` with a `serverFetch<T>(route, init, schema)` helper that reads `pp_access`, attaches `Authorization`, parses responses through the given Zod schema, and throws typed errors for non-2xx — marked with `"server-only"`
- [x] 4.4 Implement namespace modules: `lib/api/auth.ts`, `archive.ts`, `library.ts`, `search.ts`, `share.ts` — each exporting the functions enumerated in the spec
- [x] 4.5 Create `app/api/pp/[...path]/route.ts` generic proxy route: attaches the bearer, forwards method + body + query, streams the response, and on 401 calls the refresh endpoint and retries once (single-flight guard via a module-level `Map<userId, Promise>`)
- [x] 4.6 Create a client-side thin wrapper `lib/client-api.ts` (marked with `"use client"`) that fetches `/api/pp/...` routes and throws the same typed errors, for use inside Client Components
- [x] 4.7 Set up React Query: `components/providers/query-provider.tsx` with `QueryClient`, `QueryClientProvider`, and `queryClient.clear()` on logout
- [x] 4.8 Integration-test the API client against a running Compose stack in CI (`pagepocket` backend) for every namespace's success + key error paths

## 5. App Shell

- [x] 5.1 Create route group directories `app/(marketing)/`, `app/(app)/`, `app/(share)/` each with their own `layout.tsx`
- [x] 5.2 Implement the marketing layout: top nav (logo, pricing, features, sign-in), footer
- [x] 5.3 Implement the app layout: left sidebar slot (collections tree), topbar slot (search, theme toggle, user menu), main content slot; wrap in `QueryClientProvider` and `ThemeProvider`; redirect to `/login` if no session
- [x] 5.4 Implement the share layout: centered "Shared via PagePocket" bar at top, full-viewport main slot; no auth lookup
- [x] 5.5 Add `loading.tsx` and `error.tsx` siblings for every data-driven route in `(app)`
- [x] 5.6 Implement `<EmptyState />` component (icon + title + description + primary CTA)

## 6. Auth Pages

- [x] 6.1 Implement `app/(marketing)/login/page.tsx` form (email, password) calling `/api/session`; surface invalid-credentials, rate-limit, and contract errors
- [x] 6.2 Implement `app/(marketing)/register/page.tsx` form (email, password, name) with client-side Zod validation + strength indicator; surface 409 conflict
- [x] 6.3 Implement password-reset stub page at `app/(marketing)/forgot-password/page.tsx` (form + "coming soon" notice; submits to a /api/session/forgot stub that returns 202 without doing anything real)
- [x] 6.4 Add a top-right "Sign in" → "Open dashboard" CTA swap in the marketing nav when authenticated (read cookie in a Server Component)
- [x] 6.5 Playwright e2e: register → redirected to `/app` → logout → redirected to `/`

## 7. Dashboard

- [x] 7.1 Implement `app/(app)/page.tsx` as the dashboard listing pages; initial data fetched server-side via the typed API client
- [x] 7.2 Implement `PageCard` component with title, hostname, archived-at via `date-fns`, thumbnail placeholder (favicon + first-letter tile), and action icons (Open, Share, Move, Delete)
- [x] 7.3 Implement infinite scroll with `useInfiniteQuery` + `IntersectionObserver` sentinel; render "You've reached the end" at completion
- [x] 7.4 Implement sort menu (archived_at desc / title asc) that updates the URL `?sort_by=...` and refetches from page 1
- [x] 7.5 Implement Delete action with optimistic removal and rollback-on-error toast
- [x] 7.6 Implement Move-to-collection action: combobox, optimistic update in the cache, Undo toast
- [x] 7.7 Implement dashboard empty state with "Install extension" + "Watch demo" CTAs
- [x] 7.8 Playwright e2e: seed 30 pages via API → dashboard lists them → scroll triggers next page → delete a page → optimistic removal verified

## 8. Page Viewer

- [x] 8.1 Implement `app/(app)/pages/[pageId]/page.tsx` as a Server Component fetching `archive.viewPage(pageId)` and rendering `<PageViewerShell initialViewer={viewer} pageId={pageId} />` (a client component)
- [x] 8.2 Implement `<PageViewerShell>` client component that holds the iframe, a 48-px sticky header (title + source URL link + Back + Share + Delete), and a timer refetching the presigned URL 5 minutes before `expires_at`
- [x] 8.3 Hard-code the iframe `sandbox="allow-same-origin allow-popups allow-forms"` — add an ESLint rule or unit test that fails if the attribute drifts
- [x] 8.4 Implement keyboard shortcuts (`Esc`, `S`, `Del`) via a `useHotkeys` helper scoped to the viewer
- [x] 8.5 Not-found state: when the Server Component catches `NotFoundError`, return Next.js `notFound()` → `not-found.tsx` sibling renders
- [x] 8.6 Playwright e2e: create a page via gateway → navigate to viewer → iframe `sandbox` attribute asserted → Esc returns to `/app`

## 9. Collections

- [x] 9.1 Implement `<CollectionTree />` in the app sidebar: fetch all collections on mount via React Query; build the parent/child tree; render with expand/collapse state persisted in `localStorage`
- [x] 9.2 Implement "New collection" dialog (name, colour picker, parent selector) calling `library.createCollection`
- [x] 9.3 Implement `<CollectionContextMenu>` with Rename, Recolour, Add sub-collection, Delete
- [x] 9.4 Implement inline rename editor; PATCH on Enter, Escape cancels
- [x] 9.5 Implement Delete confirm dialog with the "pages are not deleted" warning copy
- [x] 9.6 Install `@dnd-kit/core` and `@dnd-kit/sortable`; wrap the dashboard list and tree in `<DndContext>`; enable dragging a `PageCard` onto a tree node
- [x] 9.7 Implement drop-target highlighting on hover and the "already in this collection" visual state
- [x] 9.8 Implement the keyboard-accessible alternative: `Shift+M` on a focused card opens a combobox of collections
- [x] 9.9 Implement the `/app/collections/[id]` route that filters the dashboard by collection (reuses the dashboard component with a `collection_id` prop)
- [x] 9.10 Playwright e2e: create collection tree → drag page onto child → assert page appears under that collection → delete parent → assert children reparent to root

## 10. Search

- [x] 10.1 Implement `<TopbarSearch>` client component: input, submit navigates to `/app/search?q=...`, on-blur clears preview dropdown
- [x] 10.2 Implement debounced typeahead dropdown (optional, 250 ms, page_size=5); selection navigates to `/app/pages/[id]`
- [x] 10.3 Implement `app/(app)/search/page.tsx` reading `q`, `page`, `collection_id` from URL; empty `q` renders a placeholder
- [x] 10.4 Implement result card with `<mark>`-highlighted snippets; sanitise by treating server-provided snippet as plain text and applying highlights client-side (or rely on server-provided already-marked snippet, in which case escape everything else)
- [x] 10.5 Implement collection filter chip with remove-X
- [x] 10.6 Implement arrow-key navigation across results
- [x] 10.7 Add virtualisation with `@tanstack/react-virtual` when `total > 200`
- [x] 10.8 Playwright e2e: seed pages with known body text → search → assert highlighted snippets → filter by collection → assert narrowed results

## 11. Sharing

- [x] 11.1 Implement `<ShareDialog>` with: public toggle (default on), expiry picker (Never, 24 h, 7 d, 30 d, custom date), Create/Copy/Revoke button states
- [x] 11.2 On open, call `share.getLinkForPage(pageId)`; if an active link exists, render the Copy+Revoke state; otherwise render the Create state
- [x] 11.3 Implement Copy button with Clipboard API primary + execCommand fallback + manual-select fallback
- [x] 11.4 Implement Revoke with confirm step; on success revert to pre-creation state
- [x] 11.5 Implement `app/(share)/s/[token]/page.tsx` as a Server Component calling `share.validatePublic(token)` unauthenticated; on `{ url, expires_at }` render the share viewer shell + iframe; on 404 render an "expired/revoked" state and set the response status to 404
- [x] 11.6 Add `<meta name="robots" content="noindex, nofollow">` to the public share viewer
- [x] 11.7 Implement client-side timer on the public viewer that reloads the page 10 s before `expires_at`
- [x] 11.8 Playwright e2e: create a page → open share dialog → copy link → open link in an incognito context → iframe renders → revoke → re-open → 404 state

## 12. Marketing

- [x] 12.1 Implement `app/(marketing)/page.tsx` (landing) with hero, feature grid, CTA band, footer — all Server Components
- [x] 12.2 Implement `app/(marketing)/pricing/page.tsx` with three plan cards; "Coming soon" disabled CTAs on Pro and Team
- [x] 12.3 Implement `app/(marketing)/features/page.tsx` with TOC and five anchored sections matching the five capabilities
- [x] 12.4 Implement `generateMetadata` on each marketing route with title, description, OG, Twitter card
- [x] 12.5 Add a `size-limit` config + CI check failing if any marketing route exceeds 120 KB gz first-load JS

## 13. Environment & Deployment

- [x] 13.1 Add `.env.example` with `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_MARKETING_SITE_URL`, `COOKIE_DOMAIN`, `COOKIE_SECRET`
- [x] 13.2 Fail fast at boot: `lib/env.ts` validates required env vars with Zod and throws on missing/invalid values
- [x] 13.3 Add `vercel.json` (optional) documenting build command and framework preset
- [x] 13.4 Document Vercel deploy steps and non-Vercel (Node 20 standalone) deploy steps in the README
- [x] 13.5 Configure Vercel preview env var set pointing at the staging gateway

## 14. E2E & CI

- [x] 14.1 Install Playwright; scaffold `e2e/` with a `global-setup.ts` that seeds a test user via the gateway
- [x] 14.2 Write Playwright specs matching every spec's "Successful" scenario (login, register, dashboard list+scroll, viewer, collection CRUD + DnD, search + filter, share create/copy/revoke, public viewer)
- [x] 14.3 Add a `docker-compose.test.yml` that boots the backend stack and runs Playwright against it (in CI)
- [x] 14.4 Wire Playwright job into `frontend.yml`: build → start backend → run e2e → teardown

## 15. Validation

- [x] 15.1 Run `openspec validate add-pagepocket-frontend` → must report valid
- [x] 15.2 Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` clean
- [x] 15.3 Manual a11y pass with axe DevTools on every major route; document any remaining issues as follow-ups
- [x] 15.4 Lighthouse scores on marketing pages: ≥ 95 performance, ≥ 100 accessibility, ≥ 100 best practices, ≥ 100 SEO
- [x] 15.5 Confirm every `Requirement` in each spec has a covering Playwright or Vitest test referenced from tasks 3–12
