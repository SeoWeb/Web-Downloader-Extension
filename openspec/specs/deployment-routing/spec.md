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
