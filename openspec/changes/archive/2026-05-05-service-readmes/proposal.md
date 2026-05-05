## Why

Each micro-service in `pagepocket/services/` lacks a README.md, making it difficult for developers to understand a service's purpose, API surface, configuration, and how it fits into the broader architecture without reading all source files. As the codebase grows, onboarding and cross-team collaboration depend on good per-service documentation.

## What Changes

- Add a detailed `README.md` to each of the 6 micro-service directories:
  - `api-gateway/README.md`
  - `auth-service/README.md`
  - `archive-service/README.md`
  - `library-service/README.md`
  - `search-service/README.md`
  - `share-service/README.md`
- Each README will cover: overview, API/gRPC methods, configuration & environment variables, dependencies, local development instructions, and service communication details.

## Capabilities

### New Capabilities
- `service-readmes`: Comprehensive per-service README documentation for all 6 pagepocket micro-services

### Modified Capabilities
<!-- No existing spec-level behavior changes — this is documentation only -->

## Impact

- Documentation only — no code changes.
- Affected directories: `pagepocket/services/{api-gateway,archive-service,auth-service,library-service,search-service,share-service}`.
- No API, dependency, or runtime impact.
