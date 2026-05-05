## ADDED Requirements

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
Field numbers in proto messages SHALL NOT be renumbered or reused once the spec is merged; removed fields MUST be marked `reserved`.

#### Scenario: Removing a field
- **WHEN** a field is no longer needed in a future change
- **THEN** its tag number and name MUST be added to a `reserved` clause on the message and never reused

#### Scenario: Adding a field
- **WHEN** a new field is added to an existing message
- **THEN** it MUST use the next available tag number and MUST be optional (proto3 default), preserving backwards compatibility with older clients

### Requirement: Shared Status Message
Services that return a generic success/message reply SHALL use a local `StatusResponse { bool success, string message }` message in their own package (consistent shape across services, no cross-package imports required).

#### Scenario: Shape consistency
- **WHEN** any service returns a generic status
- **THEN** the message MUST be named `StatusResponse` with field 1 `bool success` and field 2 `string message`
