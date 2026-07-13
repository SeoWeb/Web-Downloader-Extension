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
| Frontend | `pagepocket/frontend/` | Next.js + pnpm | Contabo server (pm2 + nginx) |
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
- **`deploy.yml`** — runs on push to `main`. Deploys the changed components to the Contabo server over SSH via `scripts/deploy-contabo.sh`:
  - Backend: `git pull` → `docker compose up -d --build` (prod mTLS) → `make migrate`
  - Frontend: `git pull` → `pnpm build` → `pm2 restart pagepocket-frontend`
  - Extension: builds a `.zip` artifact for manual publishing to the Chrome/Firefox stores

### Required repository secrets

| Secret | Purpose |
|---|---|
| `CONTABO_HOST` | SSH host of the deployment server |
| `CONTABO_USER` | SSH user |
| `CONTABO_SSH_KEY` | Private key for SSH access |
| `CONTABO_DEPLOY_PATH` | (Optional) repo path on server; defaults to `/var/www/Web-Downloader-Extension` |

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
