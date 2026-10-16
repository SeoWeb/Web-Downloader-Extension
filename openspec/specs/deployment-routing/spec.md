# Deployment Routing Specification

## Purpose

CI gating and deploy correctness for the PagePocket platform: deploys ship exactly the CI-gated SHA, frontend deploys are CI-gated, CI is manually dispatchable, and path filters cover maintenance and schema surfaces.

## Requirements

### Requirement: Deployed Tree Equals the Gated SHA
The backend deploy SHALL check out exactly the commit that passed the CI gate: the workflow passes `github.sha` as `DEPLOY_SHA` into the deploy scripts, the scripts run `git reset --hard "$DEPLOY_SHA"`, and a script MUST abort when the deploy branch tip on origin differs from `DEPLOY_SHA` (queue race — the run is retried for the newer SHA).

#### Scenario: Deploy checks out exactly the gated SHA
- **WHEN** the backend deploy job executes for commit `S` that passed CI
- **THEN** the production tree MUST be at exactly `S` (`git reset --hard $DEPLOY_SHA`), never a newer tip pulled from `origin/pagepocket`

#### Scenario: Queue race aborts the deploy
- **WHEN** a newer commit lands on `origin/pagepocket` between CI completion and the deploy step (`origin/pagepocket != DEPLOY_SHA`)
- **THEN** the deploy script MUST fail fast with an explicit message and MUST NOT ship the ungated newer tip

### Requirement: Frontend Deploys Are CI-Gated
The frontend deploy job SHALL depend on the CI gate (`needs: [changes, ci-gate]`) with a gate condition that does not require backend file changes, so no production frontend deploy can bypass CI.

#### Scenario: Frontend deploy blocked on red CI
- **WHEN** the CI gate fails for the commit a frontend deploy would ship
- **THEN** the `deploy-frontend` job MUST NOT run

#### Scenario: Frontend-only change still gated and deployable
- **WHEN** a commit touches only `pagepocket/frontend/**`
- **THEN** the CI gate MUST evaluate it and a green run MUST allow `deploy-frontend` to proceed

### Requirement: CI Is Manually Dispatchable
The CI workflow SHALL expose `workflow_dispatch` so a maintainer can re-run the gate manually (e.g. after the deploy gate's failure message instructs them to).

#### Scenario: Manual dispatch triggers the gate
- **WHEN** a maintainer triggers `workflow_dispatch` on the CI workflow for the deploy branch
- **THEN** the CI workflow runs the same gates as a push-triggered run

### Requirement: Path Filters Cover Maintenance and Schema Surfaces
The `paths`/`paths-ignore` filters in both `ci.yml` and `deploy.yml` SHALL include the production maintenance scripts (`scripts/prod/archive-maintenance/**`), `requirements-dev.txt`, and `init.sql`, so changes to those surfaces cannot silently skip CI or deploy.

#### Scenario: Maintenance-sidecar change triggers CI
- **WHEN** a commit modifies `scripts/prod/archive-maintenance/**`
- **THEN** the CI workflow MUST run for that commit

#### Scenario: Dev-dependency and schema changes trigger CI
- **WHEN** a commit modifies `requirements-dev.txt` or `init.sql`
- **THEN** the CI workflow MUST run for that commit (and the deploy workflow's filters MUST stay consistent with CI's)

### Requirement: Routing contract
The deployment SHALL define, and document, exactly one public entry point per backend: the pagepocket gateway (:8090) serves `pagepocket.app` API traffic; the monolith's public hostname (`server.pagepocket.app`) serves the extension's download-pipeline contract. The reverse proxy in front of each SHALL forward `X-Forwarded-Proto` and `X-Forwarded-Host`, and the monolith SHALL build absolute `download_url` values from them when the request arrives from a trusted proxy (the `TRUST_PROXY` setting, the same gate as client-IP resolution) so returned URLs are valid from the browser's perspective (correct scheme and host behind TLS-terminating proxies). Requests without forwarded headers, or from peers that are not trusted, SHALL fall back to the request's own scheme and host.

#### Scenario: Download URL is correct behind the proxy
- **WHEN** the monolith builds a session's `download_url` while serving a request that arrived via HTTPS through the reverse proxy
- **THEN** the URL uses `https` and the public hostname (from `X-Forwarded-Proto`/`X-Forwarded-Host`, honored because the peer is a trusted proxy), not the internal scheme, host, or port

#### Scenario: Forwarded headers from an untrusted peer are ignored
- **WHEN** a request carries `X-Forwarded-Proto`/`X-Forwarded-Host` but the monolith does not trust the peer (`TRUST_PROXY` disabled)
- **THEN** the headers are ignored and `download_url` is built from the request's own scheme and host

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
