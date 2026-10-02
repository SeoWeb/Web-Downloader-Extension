## ADDED Requirements

### Requirement: Typed API Client Module
The frontend SHALL provide a typed API client at `lib/api/` that exposes one function per gateway route with full request/response TypeScript types derived from runtime Zod schemas.

#### Scenario: Module shape
- **WHEN** the client is imported
- **THEN** it MUST export namespaced functions: `auth.login`, `auth.register`, `auth.refresh`, `auth.logout`; `archive.listPages`, `archive.viewPage`, `archive.deletePage`; `library.listCollections`, `library.createCollection`, `library.updateCollection`, `library.deleteCollection`, `library.addPageToCollection`, `library.removePageFromCollection`; `search.search`; `share.createLink`, `share.revokeLink`, `share.getLink`, `share.validatePublic`
- **AND** every function MUST have a return type inferred from a Zod schema via `z.infer`

### Requirement: Runtime Response Validation
Every gateway response SHALL be parsed through a Zod schema; schema failures SHALL throw a typed `ApiContractError`.

#### Scenario: Schema mismatch
- **WHEN** the gateway returns JSON that does not match the expected schema
- **THEN** the client MUST throw `ApiContractError` containing the Zod issue path and the route name
- **AND** in production the error message passed to the user MUST be generic ("Something went wrong"); the full issue MUST be logged to the server-side observability sink only

### Requirement: Typed Error Classes
The API client SHALL surface specific typed error classes so UI code can branch on error kind without string matching.

#### Scenario: Error taxonomy
- **WHEN** the client handles a non-2xx response
- **THEN** it MUST throw exactly one of: `AuthenticationError` (401 after refresh), `PermissionError` (403), `NotFoundError` (404), `ConflictError` (409), `QuotaExceededError` (402), `RateLimitError` (429, with `retryAfterSeconds`), `ValidationError` (400, with field-level issues), `ApiContractError` (schema mismatch), `NetworkError` (fetch threw)

### Requirement: Server-Side Attachment of Access Token
The API client SHALL only run in Server Components and Route Handlers, reading the access token from the `pp_access` cookie before attaching `Authorization: Bearer <token>`.

#### Scenario: Client-side usage is a type error
- **WHEN** a developer attempts to import the API client from a `"use client"` component
- **THEN** the import MUST fail with a TypeScript error (via `"server-only"` module or equivalent) so client code must go through Next.js Route Handlers

#### Scenario: Route Handler pass-through
- **WHEN** a browser fetches `/api/pp/archive/pages?page=2`
- **THEN** the Route Handler MUST read `pp_access` from cookies, attach `Authorization: Bearer <pp_access>`, forward the request to `${NEXT_PUBLIC_API_BASE_URL}/api/v1/archive/pages?page=2`, and stream the JSON back unchanged (except on 401, which triggers refresh-and-retry per the auth spec)

### Requirement: React Query Integration
The authenticated app SHALL use `@tanstack/react-query@5` for all server-state caching, with query keys that include the authenticated `user_id`.

#### Scenario: Query key convention
- **WHEN** a component queries data
- **THEN** the query key MUST start with the route name tuple, e.g. `["archive", "listPages", { page, sort_by }]`, `["library", "collections"]`, `["search", { q, collection_id, page }]`
- **AND** on logout, the entire React Query cache MUST be cleared

#### Scenario: Optimistic mutations
- **WHEN** a user performs an action with predictable outcome (e.g. delete page, add to collection)
- **THEN** the mutation MUST optimistically update the cache and roll back on error
