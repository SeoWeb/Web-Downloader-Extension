## Context

The PagePocket backend consists of 6 micro-services under `pagepocket/services/`:
- **api-gateway** (port 8000) — FastAPI REST gateway translating HTTP to gRPC
- **auth-service** (port 50051) — User registration, login, JWT token management
- **archive-service** (port 50052) — Page ingestion, R2 storage, quota enforcement
- **library-service** (port 50053) — Collection management for organizing pages
- **search-service** (port 50054) — Full-text search with MySQL FULLTEXT indexes
- **share-service** (port 50055) — Public share link generation and validation

All services communicate via gRPC, share a MySQL database, and use protobuf contracts defined in `shared/proto_generated/`. None of them currently have a README.md.

## Goals / Non-Goals

**Goals:**
- Each service gets a standalone README.md that a developer can read to understand the service without looking at source code
- READMEs follow a consistent structure: overview, API methods, configuration, dependencies, local dev instructions
- Include enough detail for onboarding: what the service does, how to run it, how to configure it, what it depends on

**Non-Goals:**
- Not writing documentation for the `shared/` utilities or `_template/` directory
- Not modifying any existing code, proto files, or configuration
- Not creating a top-level README for the services directory itself

## Decisions

**Decision: Consistent README structure across all services**
Each README will follow the same section order:
1. Overview (one-paragraph summary)
2. gRPC API / Endpoints (table of methods with request/response descriptions)
3. Configuration & Environment Variables (table with name, description, required, default)
4. Dependencies (external packages, other services, shared utilities)
5. Local Development (how to run and test the service standalone)
6. Service Communication (how this service connects to others)

Rationale: A uniform structure makes it easy to jump between service READMEs and find information predictably.

**Decision: READMEs derived from source code, not from existing specs**
Rather than paraphrasing spec files, READMEs will be written by reading the actual source code (servicer.py, models.py, main.py) to ensure accuracy. Specs can be referenced for behavioral details.

**Decision: Include gRPC method signatures in API section**
Since all services (except api-gateway) are gRPC-based, the API section will list protobuf method names, their request fields, and response fields. For api-gateway, REST endpoints will be listed instead.

## Risks / Trade-offs

- **Risk: READMEs drift from code as code changes** → Mitigation: Keep READMEs concise and focused on stable interfaces (gRPC methods, env vars). Implementation details that change frequently should not be documented.
- **Risk: Duplicating information from proto files or existing specs** → Mitigation: READMEs should summarize at a higher level than proto definitions and link to specs for detailed behavioral requirements.
