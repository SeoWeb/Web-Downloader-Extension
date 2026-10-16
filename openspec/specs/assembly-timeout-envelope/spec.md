# Assembly Timeout Envelope Specification

## Purpose

The explicit end-to-end assembly budget across the extension↔monolith↔PagePocket pipeline: the client poll timeout sized above the server's declared worst case, the cloud push kept inside the frozen unary contract envelope, and single-flight push convergence on retry.

## Requirements

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

### Requirement: Cloud push stays inside the unary envelope
The frozen unary proto contract allows exactly one `IngestPage` per session — the archive service has no upsert semantics, and a second `IngestPage` carrying the same `extension_job_id` silently drops the new assets — so batching a session across multiple `IngestPage` calls is not a valid strategy. The monolith SHALL instead guarantee that the single push message fits the gateway's gRPC message-size limit: it SHALL pre-flight the session's total payload size before uploading and, when it exceeds the 256 MB limit, fail fast with a precise `cloud_error` naming the size limit, without pointless retries. Asset reads feeding the request SHALL run under bounded parallelism so pushes for typical pages complete promptly and the largest allowed sessions stay inside the declared worst-case envelope.

#### Scenario: Oversized session fails fast before upload
- **WHEN** a session's total payload (HTML plus assets) is pre-flighted above the 256 MB gRPC message-size limit
- **THEN** the push fails immediately with a precise `cloud_error` naming the size limit
- **AND** no `IngestPage` attempt, retry, or partial upload is made

#### Scenario: Assets are read under bounded parallelism
- **WHEN** a session with many assets (e.g., 200 assets / 100 MB total) pushes to PagePocket
- **THEN** asset reads run under bounded concurrency inside the single `IngestPage` request
- **AND** no single gRPC message exceeds the configured message-size limit

#### Scenario: Push failure keeps the envelope honest
- **WHEN** the push fails after retries
- **THEN** the push fails within its declared budget
- **AND** the session reports `cloud_status="failed"` rather than hanging past the client's timeout

### Requirement: Single-flight push convergence
Because a push is a single `IngestPage` per session keyed by user-scoped idempotency (the session's `extension_job_id`), a re-run after a mid-stream failure SHALL NOT produce duplicated or partially-updated archived content: the retry reuses the same idempotency key and the archive service returns the original page. The monolith SHALL NOT split a session across multiple `IngestPage` calls — such split batches cannot converge, because later batches are silently dropped by the idempotency path.

#### Scenario: Retry after failed push converges
- **WHEN** a push fails and the monolith retries
- **THEN** the retry reuses the same user-scoped idempotency key (`extension_job_id`)
- **AND** the archive service returns the same `page_id` and the archived page is not duplicated or corrupted
