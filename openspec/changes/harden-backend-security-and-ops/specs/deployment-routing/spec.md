## ADDED Requirements

### Requirement: Routing contract
The deployment SHALL define, and document, exactly one public entry point per backend: the pagepocket gateway (:8090) serves `pagepocket.app` API traffic; the monolith's public hostname (`server.pagepocket.app`) serves the extension's download-pipeline contract. The reverse proxy in front of each SHALL forward `X-Forwarded-Proto` and `X-Forwarded-Host`, and the monolith SHALL use them when building absolute `download_url` values so returned URLs are valid from the browser's perspective (correct scheme and host behind TLS-terminating proxies).

#### Scenario: Download URL is correct behind the proxy
- **WHEN** the monolith builds a session's `download_url` while serving a request that arrived via HTTPS through the reverse proxy
- **THEN** the URL uses `https` and the public hostname (from `X-Forwarded-Proto`/`X-Forwarded-Host`), not the internal scheme, host, or port

#### Scenario: Direct access still works
- **WHEN** the monolith is reached directly (no proxy headers, e.g., local development)
- **THEN** URL construction falls back to the request's own scheme and host

### Requirement: CI runs on deploy branches
CI SHALL execute on both `main` and the deploy branch (`pagepocket`), with working path filters. The deploy branch SHALL never be able to reach production with untested code: a prod deploy SHALL run only after CI has passed on the exact commit being deployed.

#### Scenario: Push to pagepocket runs CI
- **WHEN** a commit is pushed to the `pagepocket` branch
- **THEN** the CI workflow runs the same gates as on `main`

#### Scenario: Deploy is gated on green CI
- **WHEN** the deploy workflow triggers for a commit
- **THEN** it proceeds only if CI passed for that commit
- **AND** a red CI run blocks the deploy

### Requirement: Post-deploy health checks
Every deploy job SHALL verify the deployment before declaring success: the frontend job keeps its existing curl gate, and the backend deploy job SHALL poll the gateway's `/api/v1/health` endpoint (with a bounded retry window) after restarting services, failing the job if the gateway does not become healthy.

#### Scenario: Backend health check gates the deploy
- **WHEN** the backend deploy restarts the gateway and services
- **THEN** the job polls `/api/v1/health` until it returns 200 or the retry window expires
- **AND** an unhealthy deploy fails the workflow with the service logs surfaced

#### Scenario: Failed health check preserves rollback
- **WHEN** the post-deploy health check fails
- **THEN** the previously deployed image tags remain recorded so the runbook rollback (re-pinning the previous tag) is a single step

### Requirement: One authoritative schema-migration mechanism
Schema management for the five pagepocket databases SHALL have exactly one authoritative mechanism in every environment: `alembic upgrade head` per service, run by the deploy step (or service entrypoint) before the service starts serving. `Base.metadata.create_all` SHALL be a dev/test-only convenience controlled by an explicit flag and SHALL NOT be coupled to the mTLS setting; production schema SHALL never be shaped implicitly.

#### Scenario: Deploy applies pending migrations
- **WHEN** the deploy step runs and a service's migrations are behind head
- **THEN** `alembic upgrade head` applies the pending migrations before (or as) the service starts
- **AND** the deploy fails if a migration fails

#### Scenario: Prod cannot silently run create_all
- **WHEN** the services boot in an mTLS/prod configuration
- **THEN** schema creation does not depend on the mTLS flag's value
- **AND** implicit `create_all` is disabled unless an explicit dev-only flag is set
