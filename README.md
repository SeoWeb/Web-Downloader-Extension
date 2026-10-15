# Website Downloader Extension

Chrome extension for downloading complete websites with all assets, supporting large downloads via IndexedDB storage.

## Features

- Download complete websites with HTML, CSS, JS, images, and documents
- **PagePocket Cloud Storage**: Save pages directly to your PagePocket account (no local file)
- **IndexedDB Storage Mode**: Handle unlimited site sizes without memory limits
- Multi-part ZIP downloads for large sites (>100MB)
- Full page scraping with linked pages support
- Single-file HTML export option
- Progress tracking and pause/resume support
- Automatic cleanup of old downloads
- i18n support with multiple languages

## Storage Modes

### PagePocket Cloud Storage (Optional)
- Uploads pages directly to your PagePocket account
- No local file saved — cloud-only storage
- Requires a PagePocket backend and user account (JWT auth)
- Enabled at build time via `VITE_PAGEPOCKET_URL` env var
- Users toggle cloud storage ON/OFF per session via the extension UI
- Shows upload progress, completion status, and "View in PagePocket" link

### IndexedDB (Default - Recommended)
- Stores content on disk instead of RAM
- Handles unlimited site sizes
- Slightly slower but much more reliable
- Automatically enabled for all downloads
- Multi-part ZIP support for files >100MB

### Legacy JSZip Mode
- Stores all content in RAM
- Fast for small sites (<100MB)
- May fail on large sites due to memory limits
- Can be enabled by setting `USE_INDEXEDDB = false` in `download-core.ts`

## Repository layout

This is a monorepo with three independent, deployable components, each with its own toolchain:

| Component | Path | Stack | How it deploys |
|---|---|---|---|
| Browser extension | repo root (`src/`, `vite.config.ts`) | Vite + pnpm | `.zip` artifact (manual store publish) |
| Frontend | `pagepocket/frontend/` | Next.js + pnpm | Contabo server (nginx → `:3000`; see "Production topology" below) |
| Backend | `pagepocket/services/` + `shared/` + `proto/` | Python 3.12 gRPC, Docker | Contabo server (docker compose) |

## Development

### Extension (repo root)

```bash
# Install dependencies
pnpm install

# Development mode
pnpm dev

# Build for production (outputs a .zip to zip/)
pnpm build

# Build with PagePocket cloud storage support
VITE_PAGEPOCKET_URL=https://your-pagepocket-instance.example.com pnpm build

# Lint / unit tests
pnpm style
pnpm test
```

### Frontend

```bash
cd pagepocket/frontend
pnpm install --frozen-lockfile
pnpm dev        # next dev
pnpm build      # next build
pnpm lint && pnpm typecheck && pnpm test
```

### Backend

```bash
cd pagepocket
make proto      # generate gRPC stubs
make build      # build all service images
make dev        # docker compose up (dev)
make test       # pytest across services
make migrate    # run Alembic migrations
```

## CI/CD

GitHub Actions workflows live in `.github/workflows/` and are path-filtered so only the affected component runs:

- **`ci.yml`** — runs on PRs and pushes to `main`. Builds/lints/tests the extension, frontend, and backend independently based on which files changed.
- **`deploy.yml`** — runs on push to the **`pagepocket` branch** (not `main` — `main` has diverged and is not deployed). Deploys the changed components to the Contabo server over SSH via `scripts/deploy-contabo.sh`:
  - Backend (pagepocket gRPC services + gateway): `git pull` → `docker compose up -d --build` (prod mTLS) → `make migrate`
  - Frontend: `git pull` → `pnpm build` → restart the `:3000` server — **known drift:** the workflow's deploy-frontend job assumes `pm2 restart pagepocket-frontend`, but production actually runs a plain `nohup next start` (no pm2 on the host, no auto-restart on crash or reboot). The frontend job's restart step does not match live reality until the ops runbook unifies it.
  - Extension: builds a `.zip` artifact for manual publishing to the Chrome/Firefox stores
- **The monolith (`server/`) is deployed OUTSIDE CI today**: its container is ~hand-run compose (`server/docker-compose.yml`), not touched by `deploy.yml`. A first rebuild will ship many accumulated commits at once — schedule it deliberately (see `scripts/prod/README.md`).

### Required repository secrets

| Secret | Purpose |
|---|---|
| `CONTABO_HOST` | SSH host of the deployment server |
| `CONTABO_USER` | SSH user |
| `CONTABO_SSH_KEY` | Private key for SSH access |
| `CONTABO_DEPLOY_PATH` | (Optional) repo path on server; defaults to `/var/www/Web-Downloader-Extension` |

## Production topology

Verified against the live host (185.213.25.5) in Oct 2026:

| Host | Path | Backend |
|---|---|---|
| `server.pagepocket.app` | Cloudflare → nginx :443 → `127.0.0.1:8000` | **Monolith** (`server/`) — serves the extension contract |
| `pagepocket.app` | nginx :443 → `127.0.0.1:3000` | Next.js frontend |
| `app.pagepocket.app` | no dedicated nginx server block — falls through to the default vhost (`pagepocket.app`) → `:3000` | Same frontend (works by nginx default-server semantics; one explicit `server_name` block would make it intentional) |
| (no public hostname) | direct :8090 | pagepocket API gateway — the gateway has no DNS name; it is reached only via the frontend proxy on the host |

- nginx sets `X-Forwarded-For`/`X-Forwarded-Proto`, `X-Real-IP` and `Host`; `CF-Connecting-IP` comes from the Cloudflare edge. Backends that derive client identity from forwarding headers (the gateway's rate limiter) must pin `TRUSTED_PROXIES` to the nginx host — direct-to-port traffic carries spoofable headers.
- ⚠️ **Direct port exposure**: monolith `:8000`, gateway `:8090`, and monolith MySQL `:33060` are all reachable from the internet today. Closing them (loopback bind / firewall) + credential rotation is the first hardening sequence in [`scripts/prod/README.md`](scripts/prod/README.md) (deployment & hardening runbook: deploy flow, Alembic-in-deploy, backups/restore drill, rollback).

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md) for common issues and solutions.

## Technical Details

- Built with React, TypeScript, and Vite
- Uses Dexie for IndexedDB management
- Zustand for state management
- Tailwind CSS for styling
- Radix UI primitives for accessible components
- Automatic storage quota monitoring
- 24-hour automatic cleanup of old downloads
- Chrome Extension Manifest V3
