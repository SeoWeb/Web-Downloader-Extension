# PagePocket Proto Contracts Specification

## Purpose

The gRPC contract sources shared by all PagePocket services: proto directory layout, stub generation, distribution and freshness, contract stability rules, comment accuracy, and shared status message conventions.

## Requirements

### Requirement: Canonical Proto Directory
All inter-service contracts SHALL live under `pagepocket/proto/` with one `.proto` file per service, in `proto3` syntax, and a `package` name matching the service.

#### Scenario: Required proto files
- **WHEN** the backend workspace is created
- **THEN** `pagepocket/proto/` MUST contain exactly `auth.proto` (package `auth`), `archive.proto` (package `archive`), `library.proto` (package `library`), `search.proto` (package `search`), and `share.proto` (package `share`)

#### Scenario: Required service RPCs
- **WHEN** the proto files are authored
- **THEN** they MUST declare at minimum: `AuthService { Register, Login, Verify, Refresh, Logout }`, `ArchiveService { IngestPage, GetPage, ListPages, DeletePage, GetPageContent }`, `LibraryService { CreateCollection, GetCollection, ListCollections, UpdateCollection, DeleteCollection, AddPageToCollection, RemovePageFromCollection }`, `SearchService { IndexPage, RemovePage, Search }`, `ShareService { CreateShareLink, GetShareLink, RevokeShareLink, ValidateToken }`

### Requirement: Generated Stub Distribution
Generated Python stubs SHALL be produced into `pagepocket/shared/proto_generated/` by a single `make proto` target and consumed by every service from that shared location.

#### Scenario: Stub generation command
- **WHEN** a developer runs `make proto`
- **THEN** the target MUST invoke `python -m grpc_tools.protoc -I proto --python_out=shared/proto_generated --grpc_python_out=shared/proto_generated proto/*.proto`
- **AND** produce `<name>_pb2.py` and `<name>_pb2_grpc.py` for each proto file

#### Scenario: Service Dockerfile copies stubs
- **WHEN** any service image is built
- **THEN** the Dockerfile MUST copy `shared/proto_generated/` into the image at `/app/proto_generated` before running `python main.py`

#### Scenario: No hand-edited stubs
- **WHEN** any stub file appears under `shared/proto_generated/`
- **THEN** it MUST be generated output only; hand edits MUST NOT be committed

### Requirement: Contract Stability
Field numbers in proto messages SHALL NOT be renumbered or reused once the spec is merged; removed fields MUST be marked `reserved` in the same change that stops populating them, and abandoned-but-present fields MUST be explicitly marked `[deprecated = true]` — no silently ignored fields.

#### Scenario: Removing a field
- **WHEN** a field is no longer needed in a future change
- **THEN** its tag number and name MUST be added to a `reserved` clause on the message and never reused

#### Scenario: Presigned-URL fields reserved
- **WHEN** the presigned-URL removal lands in `archive.proto` and `share.proto`
- **THEN** the response fields that carried `url`/`signed_url` and `PageResponse.r2_key` (field 6) MUST appear in `reserved` clauses with their original tag numbers, and no field may reuse those tags

#### Scenario: Abandoned field explicitly deprecated
- **WHEN** `archive.proto` declares the ignored `plan` field (field 7)
- **THEN** the field MUST carry `[deprecated = true]` (and/or move into a `reserved` clause) so its dead status is machine-checkable, not tribal knowledge

#### Scenario: Adding a field
- **WHEN** a new field is added to an existing message
- **THEN** it MUST use the next available tag number and MUST be optional (proto3 default), preserving backwards compatibility with older clients

### Requirement: Shared Status Message
Services that return a generic success/message reply SHALL use one canonical `StatusResponse { bool success, string message }` definition shared across packages (single source of truth), replacing the per-package duplicates, with the wire shape unchanged (`field 1 bool success`, `field 2 string message`).

#### Scenario: Single definition
- **WHEN** the proto sources are searched for `StatusResponse` message declarations
- **THEN** exactly one canonical definition MUST exist, imported (or generated-shared) by every service that returns it — not five per-package copies

#### Scenario: Shape compatibility preserved
- **WHEN** stubs are regenerated after the deduplication
- **THEN** the message MUST keep field 1 `bool success` and field 2 `string message`, so existing serialized responses remain decodable

### Requirement: Comment Accuracy
Proto comments SHALL accurately describe enforced runtime behavior: any comment contradicting the implemented rules (e.g. claiming a field is "empty for share-token access" where share-token access is not permitted and ownership is mandatory) MUST be corrected in the same change that enforces the behavior.

#### Scenario: Stale share-access comment corrected
- **WHEN** `archive.proto`'s user-ownership fields are reviewed
- **THEN** their comments MUST state the actual contract (ownership is mandatory; share-token access does not bypass `user_id` scoping)

#### Scenario: No comment/behavior contradictions
- **WHEN** proto files are reviewed during contract changes
- **THEN** comments describing removed or changed behavior MUST be updated alongside the schema edit (checked in the stub-regeneration task review)

### Requirement: Generated Stub Freshness
Committed stubs under `pagepocket/shared/proto_generated/` SHALL always equal the output of `make proto` for the committed `.proto` sources, and CI SHALL enforce this with a `git diff --exit-code` check after regeneration.

#### Scenario: Stale stubs fail CI
- **WHEN** a commit changes a `.proto` file without regenerating stubs
- **THEN** the CI freshness step (`make proto` + `git diff --exit-code -- pagepocket/shared/proto_generated`) MUST fail the build

#### Scenario: Regenerated stubs pass
- **WHEN** a commit includes both the `.proto` edit and its `make proto` output
- **THEN** the freshness step MUST pass with no diff
