#!/bin/bash

# PagePocket Production Restart Script
# This script rebuilds and restarts the services using the production mTLS configuration.

set -e

# Ensure we are in the pagepocket directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "🚀 Rebuilding and restarting PagePocket services (mTLS enabled)..."

# Run docker compose with production overrides
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

echo "✅ Services started."
echo "📝 To run migrations, use: make migrate"
echo "🔍 To check logs, use: docker compose logs -f"

# Tip for Frontend
# To run the frontend in production mode:
# cd frontend && HOSTNAME=0.0.0.0 PORT=3000 npm run start
