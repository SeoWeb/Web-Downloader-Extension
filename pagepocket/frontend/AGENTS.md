<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Backend Architecture

The backend lives at `../pagepocket/services/` and runs via Docker Compose (`../pagepocket/docker-compose.yml`).

## Services

| Service | Port | Purpose |
|---|---|---|
| api-gateway | 8090 | REST API gateway (frontend talks to this) |
| auth-service | 50051 | Auth/login (gRPC) |
| archive-service | 50052 | Page archiving |
| library-service | 50053 | Library management |
| search-service | 50054 | Search |
| share-service | 50055 | Sharing |
| mysql | 3306 | Shared database |

## Configuration

- Frontend env: `.env.local` sets `NEXT_PUBLIC_API_BASE_URL=http://localhost:8090/api/v1`
- All services use gRPC internally; api-gateway exposes REST to frontend
- Docker network: `pagepocket_default`
- Start: `docker compose up` from `pagepocket/` directory
