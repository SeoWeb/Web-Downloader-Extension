#!/usr/bin/env bash
# Verify the Python microservice scaffold starts correctly and exposes /docs.
# Usage: ./scripts/verify-scaffold.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
TIMEOUT=10

echo "=== Verifying server scaffold ==="

# 1. Check directory structure
for dir in app app/api app/api/routes app/models app/services app/db; do
  if [ ! -d "$SERVER_DIR/$dir" ]; then
    echo "FAIL: Missing directory $dir"
    exit 1
  fi
  if [ ! -f "$SERVER_DIR/$dir/__init__.py" ]; then
    echo "FAIL: Missing __init__.py in $dir"
    exit 1
  fi
done
echo "PASS: Directory structure"

# 2. Check key files exist
for file in requirements.txt app/config.py app/main.py Dockerfile docker-compose.yml; do
  if [ ! -f "$SERVER_DIR/$file" ]; then
    echo "FAIL: Missing file $file"
    exit 1
  fi
done
echo "PASS: Key files"

# 3. Start the server in the background and check /docs
cd "$SERVER_DIR"

# Ensure dependencies are available (skip if venv not set up)
if [ -d "venv" ]; then
  source venv/bin/activate
fi

uvicorn app.main:app --host 127.0.0.1 --port 18765 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for server to become ready
echo "Waiting for server to start..."
elapsed=0
until curl -sf http://127.0.0.1:18765/docs -o /dev/null 2>/dev/null; do
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    echo "FAIL: Server did not start within ${TIMEOUT}s"
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

echo "PASS: Server started, /docs accessible"
echo "=== All scaffold checks passed ==="
