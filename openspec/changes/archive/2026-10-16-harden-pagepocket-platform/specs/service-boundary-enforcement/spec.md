## ADDED Requirements

### Requirement: Single-Schema Data Access
Each microservice SHALL read and write only its own database schema: no service MAY issue SQL that references another service's schema (e.g. `search-service` MUST NOT query `library_db` directly), and cross-service data needs MUST be satisfied via gRPC RPCs.

#### Scenario: Collection filtering uses the library RPC
- **WHEN** `SearchService.Search` filters by `collection_id`
- **THEN** the service MUST obtain the page-id set via `LibraryService.ListCollectionPageIds` (user-scoped) instead of embedding raw SQL against `library_db.page_collections`

#### Scenario: Static cross-schema gate
- **WHEN** the service source trees are searched (e.g. `grep -r "library_db" pagepocket/services/search-service/`)
- **THEN** no cross-schema SQL references MUST be found in services outside the owning service

### Requirement: Least-Privilege Per-Service Database Credentials
Every service SHALL connect to MySQL with a dedicated least-privilege user scoped to its own schema (e.g. `pagepocket_archive` → `archive_db` only), provisioned by `init.sql` plus a `scripts/prod/rotate-db-users.sh` rotation script; the production compose overlay MUST require the scoped credentials while development falls back to the shared root user for convenience.

#### Scenario: Prod overlay uses scoped users
- **WHEN** the production compose overlay is rendered
- **THEN** each service's `DB_URL` MUST reference its own `pagepocket_<service>` user (never `root`)

#### Scenario: Rotation script is prepared and deploy-gated
- **WHEN** `scripts/prod/rotate-db-users.sh` is reviewed
- **THEN** it MUST create/rotate the per-service MySQL users with grants limited to their own schema
- **AND** execution against production MUST happen only as a user-ordered deploy action per the `scripts/prod/` convention

#### Scenario: Cross-schema access fails at the DB level
- **WHEN** a service attempts to query a foreign schema using its scoped credentials
- **THEN** MySQL MUST deny the operation (the boundary is enforced by grants, not convention)

### Requirement: Monolith Network Confinement
The production compose network policy SHALL restrict the legacy monolith so it can reach only `archive-service` and `auth-service`; the monolith's addresses for search, library, and share services SHALL be unreachable from its container. The confinement is compose-only (no monolith code changes) and its application to production is deploy-gated.

#### Scenario: Allowed services reachable
- **WHEN** the monolith container resolves and connects to `archive-service` or `auth-service` on the docker network
- **THEN** the connections MUST succeed

#### Scenario: Foreign services blocked
- **WHEN** the monolith container attempts to reach `search-service`, `library-service`, or `share-service`
- **THEN** the connection MUST fail (network policy), limiting the monolith's blast radius

#### Scenario: Confinement is applied on user-ordered deploy only
- **WHEN** the confinement changes are merged
- **THEN** the prod overlay edit and its verification steps MUST be documented in the runbook and applied only during a user-ordered deploy
