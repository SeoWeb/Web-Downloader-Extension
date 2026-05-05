# PagePocket Frontend

Next.js 16 (App Router) frontend for the PagePocket SaaS — a web archiving and organisation tool.

## Quick Start

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

Copy `.env.example` to `.env.local` and fill in values:

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | Yes | Gateway API base URL (e.g. `http://localhost:8080/api/v1`) |
| `NEXT_PUBLIC_MARKETING_SITE_URL` | Yes | Public marketing URL (e.g. `http://localhost:3000`) |
| `COOKIE_DOMAIN` | No | Cookie domain override (default: `localhost`) |
| `COOKIE_SECRET` | Yes | Secret for signing cookies |

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start dev server (Turbopack) |
| `pnpm build` | Production build |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript type check |
| `pnpm test` | Run Vitest |
| `pnpm test:watch` | Vitest watch mode |
| `pnpm format` | Format with Prettier |
| `pnpm format:check` | Check formatting |

## Architecture

```
src/
  app/              # Next.js App Router pages
    (marketing)/    # Public: landing, pricing, login, register
    (app)/          # Authenticated: dashboard, viewer, collections, search
    (share)/        # Public share viewer: /s/[token]
    api/            # Route Handlers (auth proxy, session management)
  components/
    ui/             # shadcn/ui primitives + design-system components
    providers/      # React context providers (QueryClient, Theme)
  lib/
    api/            # Typed API client, Zod schemas, error classes
    auth/           # Cookie helpers, server-session decoding
    env.ts          # Zod-validated env vars
```

### Key Patterns

- **Auth**: JWTs stored in httpOnly cookies; browser never touches raw tokens. All authenticated requests go through `/api/pp/*` Route Handlers.
- **Server Components**: Data fetching and auth checks happen server-side. Client components handle interactivity only.
- **Design System**: Tailwind v4 + shadcn/ui (copy-in). Tokens defined as CSS custom properties in `globals.css`.
- **State**: `@tanstack/react-query` for server state. URL params for search/filters. Component state for local UI.

## Deployment

### Vercel (recommended)

1. Connect the repo to Vercel and set the **root directory** to `pagepocket/frontend`.
2. In **Settings > Environment Variables**, configure all variables from `.env.example` for each environment:
   - **Production**: point `NEXT_PUBLIC_API_BASE_URL` at the production gateway.
   - **Preview**: point `NEXT_PUBLIC_API_BASE_URL` at the staging gateway (see `.env.preview` for reference). Set these under the **Preview** tab, not Production.
3. Deploy — Vercel detects the Next.js framework automatically via `vercel.json`.

### Node.js standalone

Requires **Node 20+**.

```bash
# 1. Build
pnpm build

# 2. Set production environment variables
cp .env.example .env.production.local
# Edit .env.production.local with production values

# 3. Run
HOSTNAME=0.0.0.0 PORT=3000 node .next/standalone/server.js
```

For production, run behind a reverse proxy (nginx, Caddy, or cloud LB) that terminates TLS and forwards to the Node server. Use a process manager (PM2, systemd) for restarts and log management.

## Contributing

1. Create a feature branch from `main`
2. Make changes with tests
3. Ensure `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass
4. Open a pull request
