## ADDED Requirements

### Requirement: Explicit assembly-timeout envelope
The end-to-end assembly budget SHALL be explicit and consistent across the pipeline: the server-side cloud push budget (sequential gRPC call deadlines plus queue wait) SHALL be documented as the server's worst case, and the extension's assembly poll timeout SHALL exceed that worst case with margin. The client timeout SHALL never be smaller than the server's maximum expected assembly time.

#### Scenario: Envelope numbers hold
- **WHEN** the server's push budget is 3 sequential gRPC calls at 600 s each plus up to 120 s queue wait (32 minutes worst case)
- **THEN** the extension's assembly poll timeout is at least 35 minutes
- **AND** the extension no longer abandons assemblies that the server is still actively completing

#### Scenario: Server documents its budget in status
- **WHEN** a client queries a session in `assembling` status during a cloud push
- **THEN** the status response distinguishes an actively progressing push from a stalled one (e.g., phase timestamps)
- **AND** the client can surface elapsed assembly time to the user instead of failing silently

### Requirement: Cloud push meets a performance target
The monolith's cloud push SHALL upload assets in bounded parallel batches (each batch sized well below the gRPC message limit) rather than one monolithic unary message, targeting a p95 push time of at most 10 minutes for typical pages and staying within the declared worst-case envelope for the largest allowed sessions.

#### Scenario: Large page pushes in batches
- **WHEN** a session with 200 assets and 100 MB total payload pushes to PagePocket
- **THEN** assets are uploaded as multiple batched `IngestPage`-compatible requests under bounded concurrency
- **AND** no single gRPC message exceeds the configured message-size limit

#### Scenario: Push failure keeps the envelope honest
- **WHEN** a batch fails after retries
- **THEN** the push fails within its declared budget
- **AND** the session reports `cloud_status="failed"` rather than hanging past the client's timeout

### Requirement: Idempotent batched push
Because a push is now split into batches, re-running a push after a mid-stream failure SHALL NOT produce duplicated or partially-updated archived content: either the existing user-scoped ingest idempotency (same `extension_job_id`) returns the original page, or a retry semantics is defined that converges to a single complete page.

#### Scenario: Retry after partial push converges
- **WHEN** a push fails after some batches were accepted and the monolith retries
- **THEN** the archive service returns the same `page_id` for the same `extension_job_id`
- **AND** the archived page is not duplicated or corrupted
