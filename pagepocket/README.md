# PagePocket Backend

SaaS backend for the PagePocket cloud archive service.

## Quick Start

```bash
# 1. Generate proto stubs
make proto

# 2. Generate mTLS certificates (dev uses plaintext; prod needs certs)
make certs

# 3. Start the stack
docker compose up -d

# 4. Run database migrations
make migrate

# 5. Verify
curl http://localhost:8000/api/v1/health
```

## Architecture

Six microservices behind a single REST gateway:

| Service | Port | Role |
|---------|------|------|
| api-gateway | 8000 | Public REST → gRPC bridge, JWT auth, rate limiting |
| auth-service | 50051 | User registration, login, JWT issuance |
| archive-service | 50052 | Page ingestion, R2 storage, quotas |
| library-service | 50053 | Collections and page organization |
| search-service | 50054 | Full-text search (MySQL ngram) |
| share-service | 50055 | Share link tokens |

## Environment Variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `MYSQL_ROOT_PASSWORD` | mysql | Root password |
| `JWT_SECRET` | auth, gateway | HS256 signing key |
| `R2_ENDPOINT_URL` | archive | Cloudflare R2 endpoint |
| `R2_ACCESS_KEY_ID` | archive | R2 access key |
| `R2_SECRET_ACCESS_KEY` | archive | R2 secret key |
| `R2_BUCKET_NAME` | archive | R2 bucket name |
| `BASE_URL` | share | Public base URL for short links |
| `MTLS_ENABLED` | all | Enable mTLS (`true`/`false`) |
| `*_SERVICE_ADDR` | gateway | gRPC addresses for each service |

## Proto Workflow

1. Edit `.proto` files in `proto/`
2. Run `make proto` to regenerate stubs in `shared/proto_generated/`
3. Generated stubs are tracked in git for reproducibility
4. Update affected services if message shapes change

## Make Targets

- `make proto` — Generate gRPC stubs
- `make build` — Build Docker images
- `make dev` — Start dev stack
- `make migrate` — Run Alembic migrations
- `make test` — Run all tests
- `make lint` — Run ruff linter
- `make format` — Run ruff + black
- `make certs` — Generate mTLS certificates

## Production Deployment

On a single VM, manage the stack with a systemd unit:

```bash
# Deploy
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Systemd unit

Create `/etc/systemd/system/pagepocket.service`:

```ini
[Unit]
Description=PagePocket SaaS Backend
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/pagepocket
ExecStart=/usr/bin/docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
ExecStop=/usr/bin/docker compose -f docker-compose.yml -f docker-compose.prod.yml down
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable pagepocket
sudo systemctl start pagepocket
```

Certificate rotation: regenerate with `make certs` then `sudo systemctl restart pagepocket`.

## Troubleshooting

- **Stubs import error**: Run `make proto` to regenerate
- **Migration fails**: Ensure MySQL is healthy (`docker compose ps mysql`)
- **mTLS handshake fails**: Verify cert paths match env vars, regenerate with `make certs`
