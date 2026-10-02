#!/usr/bin/env bash
#
# PagePocket deploy script — runs on the Contabo server via GitHub Actions SSH.
# Usage: bash scripts/deploy-contabo.sh <backend|frontend|all>
#
# Expected environment (provided by the server / CI):
#   CONTABO_DEPLOY_PATH   path to the checked-out repo (default below)
#   The repo must already be cloned and have push/pull access (deploy key).

set -euo pipefail

REPO_DIR="${CONTABO_DEPLOY_PATH:-/var/www/Web-Downloader-Extension}"
TARGET="${1:-all}"

cd "$REPO_DIR"
echo "==> Deploying from $REPO_DIR (target: $TARGET)"

git pull origin main

if [ "$TARGET" = "backend" ] || [ "$TARGET" = "all" ]; then
  echo "==> Rebuilding backend services (docker compose, prod mTLS)"
  cd "$REPO_DIR/pagepocket"
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
  echo "==> Running database migrations"
  make migrate || echo "::warning:: migrations did not complete; check logs"
  cd "$REPO_DIR"
fi

if [ "$TARGET" = "frontend" ] || [ "$TARGET" = "all" ]; then
  echo "==> Building & restarting frontend (Next.js + pm2)"
  cd "$REPO_DIR/pagepocket/frontend"
  pnpm install --frozen-lockfile
  pnpm build
  if pm2 describe pagepocket-frontend >/dev/null 2>&1; then
    pm2 restart pagepocket-frontend
  else
    pm2 start "pnpm start" --name pagepocket-frontend
  fi
  cd "$REPO_DIR"
fi

echo "==> Deploy finished"
