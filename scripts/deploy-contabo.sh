#!/usr/bin/env bash
#
# PagePocket deploy helper — LOCAL WRAPPER ONLY (prints the deploy plan).
#
# Real deploys are executed by GitHub Actions (.github/workflows/deploy.yml):
#   - trigger: push to `pagepocket`, or manual `gh workflow run deploy.yml`
#   - backend:  SSH to Contabo → git reset --hard origin/pagepocket →
#               docker compose (base + prod overlay) rebuilds the 5 gRPC
#               services, restarts api-gateway, prints `docker ps`
#   - frontend: SSH to Contabo → git reset --hard origin/pagepocket →
#               pnpm install --frozen-lockfile && pnpm build → keep one
#               .next.bak-* → restart plain `next start` on :3000 →
#               verify with curl
#
# This script intentionally no longer deploys directly: the previous version
# drifted from production reality (pm2 + `git pull origin main` no longer
# apply; production trunk is `pagepocket`, frontend is a plain `next start`).
# Keeping a single deploy codepath (the workflow) avoids future drift.
#
# To deploy: push to `pagepocket`, or run:
#   gh workflow run deploy.yml --ref pagepocket

set -euo pipefail

cat <<'EOF'
==> Deploys run via CI: .github/workflows/deploy.yml (production branch: pagepocket)

  Backend job (runs when pagepocket/services|shared|proto|compose files change):
    cd /var/www/Web-Downloader-Extension
    git fetch origin && git reset --hard origin/pagepocket
    cd pagepocket
    docker compose -f docker-compose.yml -f docker-compose.prod.yml \
      up -d --build --no-deps \
      archive-service auth-service library-service search-service share-service
    docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api-gateway
    docker ps --filter name=pagepocket --format '{{.Names}}\t{{.Status}}'

  Frontend job (runs when pagepocket/frontend changes):
    cd /var/www/Web-Downloader-Extension
    git fetch origin && git reset --hard origin/pagepocket
    cd pagepocket/frontend
    pnpm install --frozen-lockfile
    pnpm build
    rm -rf .next.bak-* && cp -al .next ".next.bak-$(date +%s)"   # keep one rollback copy
    pkill -f 'next[ ]start' / 'next[-]server' || true
    nohup npm run start > next.log 2>&1 &
    curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/   # must be 2xx/3xx

  Manual trigger: gh workflow run deploy.yml --ref pagepocket
EOF
