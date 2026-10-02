## Why

The `add-pagepocket-saas-backend` change defines an API Gateway that exposes every PagePocket capability (auth, archive, library, search, share) as REST under `/api/v1/*`, but there is no user-facing surface for it. Students, researchers, and any non-extension user currently cannot see their saved pages, organise them, search them, or share them. We need a web frontend that turns the backend contract into a usable product: a fast login, a dashboard listing every archived page, a clean viewer for opening saved pages without broken layouts, collections with drag-and-drop organisation, full-text search with highlighted snippets, and hashed shareable links for public/private sharing. Next.js (App Router) in TypeScript is the right choice because it gives us server components for auth-aware layouts, streaming lists for large archives, and first-class SEO for public share pages.

## What Changes

- Add a `pagepocket/frontend/` Next.js 15 (App Router) TypeScript application alongside the backend workspace.
- Add authenticated app shell with login, register, logout, and token-refresh flows hitting the gateway's `/api/v1/auth/*` routes.
- Add dashboard (`/app`) listing the user's archived pages with infinite scroll, sort by `archived_at` / `title`, thumbnail placeholders, and per-page actions (open, move to collection, share, delete).
- Add a clean page viewer (`/app/pages/[pageId]`) that resolves the gateway's presigned R2 URL and renders the saved HTML in a sandboxed iframe with a minimal chrome (title, source URL, archived-at, actions bar).
- Add collections management (`/app/collections` + left-nav tree) with create/rename/recolor/delete, nested parent/child structure, and HTML5 drag-and-drop of pages between collections — calling the gateway's `/api/v1/library/collections` + `/api/v1/library/collections/{id}/pages` routes.
- Add full-text search (`/app/search?q=...`) with debounced input, result cards showing highlighted snippets, keyboard navigation, and optional `collection_id` filter — calling `GET /api/v1/search`.
- Add share link management: per-page "Share" dialog to create a hashed public token (with optional expiry), revoke, copy-link, and view-count display, calling `/api/v1/share`.
- Add public share viewer (`/s/[token]`) that works unauthenticated, calls `GET /api/v1/share/public/{token}`, and renders the presigned R2 HTML in a sandboxed iframe with watermarked chrome ("Shared via PagePocket").
- Add a marketing landing page at `/` and pricing at `/pricing` scaffolded for content (copy-level only; no Stripe integration in this change).
- Add a typed API client (`src/lib/api/`) that wraps every public gateway route, transparently refreshes JWTs on 401, and surfaces typed errors.
- Add a global error/empty/loading state system (toast notifications, skeletons, and error boundaries) so no view ever leaves the user staring at a blank screen.
- Add a dark-mode-capable design system built on Tailwind CSS v4 + shadcn/ui components.
- Add Cypress or Playwright end-to-end tests for the critical paths (register → list → view → search → share → revoke).

### Non-goals (this change)

- No Stripe checkout, plan upgrade UI, or billing webhooks (tracked for a later change).
- No annotations/highlights, AI summaries, citation export, or change-monitoring UI (Phase 5 in the original SaaS plan).
- No mobile native app; responsive web only.
- No in-app extension install flow — the extension is shipped separately; frontend only links to the Chrome Web Store.
- No server-side rendering of saved page content — viewer always uses an iframe pointing at the presigned R2 URL (security + correctness; avoids re-processing HTML).
- No changes to the backend or the existing browser extension.

## Capabilities

### New Capabilities

- `pagepocket-frontend-shell`: Next.js App Router application scaffold, root layout, theming (light/dark), global error/loading UX, protected-route guard, and authenticated layout chrome (sidebar + topbar).
- `pagepocket-frontend-auth`: Login, register, logout, forgot-password-placeholder flows; token storage in httpOnly cookies via Next.js Route Handlers; silent refresh; route-level auth guards.
- `pagepocket-frontend-api-client`: Typed fetch wrapper with per-route response types, automatic bearer-token attachment, 401-triggered silent refresh with single-flight guard, and typed error classes.
- `pagepocket-frontend-dashboard`: Dashboard page listing archived pages with infinite scroll, sort controls, empty state, and per-row actions; cursor-based pagination over the gateway's offset pagination.
- `pagepocket-frontend-page-viewer`: Authenticated page viewer that fetches a presigned R2 URL from the gateway and renders it in a sandboxed iframe with a minimal chrome and a "Back to library" action.
- `pagepocket-frontend-collections`: Left-nav collection tree, CRUD dialogs, recolour, rename, nesting, and HTML5 drag-and-drop of pages between collections.
- `pagepocket-frontend-search`: Debounced full-text search with highlighted snippets, keyboard navigation, URL-as-state (`?q=` and `?collection_id=`), and result virtualisation for large result sets.
- `pagepocket-frontend-sharing`: Per-page share dialog with public/private flag, optional expiry picker, copy-link, revoke, view-count display; public unauthenticated viewer route at `/s/[token]`.
- `pagepocket-frontend-marketing`: Static landing page at `/`, pricing page at `/pricing`, and a feature page — all cacheable, SEO-friendly, and rendered as React Server Components.
- `pagepocket-frontend-design-system`: Tailwind v4 + shadcn/ui component set, design tokens, dark-mode toggle, toast/notification primitives, and accessibility-first form controls.

### Modified Capabilities

_None_ — the frontend is a new surface; the gateway contract is already captured in `pagepocket-api-gateway`, `pagepocket-archive-service`, `pagepocket-library-service`, `pagepocket-search-service`, and `pagepocket-share-service` specs from the backend change. This frontend consumes those contracts without modifying them.

## Impact

- **New codebase**: `pagepocket/frontend/` Next.js 15 TypeScript workspace (App Router, React 19, Tailwind v4). Initial footprint ~80–120 files.
- **Deployment**: Static + server-rendered hybrid. Target: Vercel (preferred) or any Node 20 host; `NEXT_PUBLIC_API_BASE_URL` points at the deployed API Gateway.
- **Dependencies** (non-exhaustive): `next@15`, `react@19`, `typescript@5`, `tailwindcss@4`, `@radix-ui/react-*` (via shadcn/ui), `zod` (runtime schema validation of gateway responses), `@tanstack/react-query@5` (server-state caching), `react-hook-form`, `@dnd-kit/core` + `@dnd-kit/sortable` (drag-and-drop over HTML5 DnD for better a11y and touch), `date-fns`, `sonner` (toasts).
- **Auth storage**: Access and refresh tokens live in httpOnly, SameSite=Lax cookies set via a Next.js Route Handler; frontend JS never touches raw tokens.
- **Public share route**: `/s/[token]` is an unauthenticated Server Component that fetches the presigned URL at request time and streams the viewer shell; bots can crawl titles if the token is public.
- **Testing**: Playwright for e2e; Vitest + React Testing Library for unit/component tests.
- **CI**: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` in GitHub Actions; e2e runs against a local Docker Compose backend stack.
- **Env contract**: requires `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_MARKETING_SITE_URL`, `COOKIE_DOMAIN` (server-only), `COOKIE_SECRET` (server-only). No secrets on the client.
- **No backend changes**: the backend change is assumed deployed or deployable; this change has a hard dependency on it but does not modify it.
