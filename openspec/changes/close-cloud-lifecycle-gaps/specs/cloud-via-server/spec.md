## ADDED Requirements

### Requirement: Opt-in federated delete of cloud pages

When an API-key client deletes a server session, the monolith SHALL additionally delete the archived PagePocket page only when the caller explicitly opts in via the `delete_cloud` query parameter, the session's cloud push succeeded (`cloud_status == "success"` with a `cloud_page_id`), and the calling client's cloud binding still matches the session's cloud identity (`session.pagepocket_user_id == client.pagepocket_user_id`). The local session deletion SHALL remain authoritative: it SHALL happen first and SHALL succeed even when the cloud-side delete fails or is skipped, with the per-target outcome reported in the response. A missing cloud page SHALL be treated as already deleted (idempotent success). The extension SHALL surface this as a default-OFF checkbox shown only for cloud-success sessions.

#### Scenario: Opt-in deletes the cloud page alongside the local session

- **WHEN** `DELETE /api/v1/sessions/{id}?delete_cloud=true` targets a session with `cloud_status == "success"` whose `pagepocket_user_id` matches the calling client's binding
- **THEN** the monolith deletes the local session (files + record) and calls `ArchiveService.DeletePage` for the session's `cloud_page_id`
- **AND** returns `{"deleted": true, "cloud": {"deleted": true}, "api_version": "v1"}`

#### Scenario: Default is local-only

- **WHEN** `DELETE /api/v1/sessions/{id}` is sent without `delete_cloud` (or with `delete_cloud=false`)
- **THEN** only the local session is deleted and no cloud RPC is made
- **AND** the response reports `{"deleted": true, "cloud": {"deleted": false, "reason": "not_requested"}, "api_version": "v1"}`

#### Scenario: Binding mismatch skips the cloud delete

- **WHEN** `delete_cloud=true` but the calling client's binding no longer matches the session's cloud identity (the client unbound or re-bound to another PagePocket user)
- **THEN** the local deletion proceeds and the cloud page is left untouched
- **AND** the response reports `cloud: {"deleted": false, "reason": "binding_mismatch"}`

#### Scenario: Cloud delete failure never fails the local delete

- **WHEN** the `DeletePage` RPC fails (network error, gRPC failure) during an opted-in delete
- **THEN** the response is still HTTP 200 with `{"deleted": true, "cloud": {"deleted": false, "reason": "cloud_error"}, "api_version": "v1"}`
- **AND** the local session and its files are gone (no rollback, no retry of the cloud delete)

#### Scenario: Missing cloud page is already-deleted success

- **WHEN** the opted-in cloud delete targets a page that no longer exists on the archive service
- **THEN** the outcome is `{"deleted": true, "cloud": {"deleted": true}}` (NOT_FOUND treated as idempotent success)

#### Scenario: Extension checkbox defaults off and is cloud-only

- **WHEN** a cloud-mode session (`cloud_status == "success"`) is deleted from the panel without checking "Also remove from PagePocket"
- **THEN** only the local server session is deleted (`delete_cloud` omitted)
- **AND** the checkbox is rendered only for cloud-success sessions and defaults to unchecked

### Requirement: Push pre-flight asset-count parity

The monolith's cloud push SHALL enforce the same asset-count cap the gateway enforces on REST ingest: `push_to_archive` SHALL reject, deterministically and before any gRPC traffic, a session whose asset count exceeds the configured cap (monolith env `CLOUD_MAX_ASSETS`, default 200 — matching the gateway's `MAX_INGEST_ASSETS` default). The rejection SHALL be stat-only (no proto message built, no RPC sent, no retry budget consumed) and SHALL surface through the existing cloud failure path (`cloud_status = "failed"`, `cloud_error` message) while the session itself remains ready for local download.

#### Scenario: Over-cap push rejected before any gRPC traffic

- **WHEN** a finalized session with more than `CLOUD_MAX_ASSETS` assets is pushed to the archive service
- **THEN** the push fails immediately with a deterministic asset-count error — no `IngestPageRequest` is built, no RPC is sent, and the 3-attempt retry budget is not consumed
- **AND** the session status reports `cloud_status: "failed"` with the asset-count `cloud_error` while the session remains ready for local download

#### Scenario: Default cap matches the REST ingest path

- **WHEN** no `CLOUD_MAX_ASSETS` value is configured on the monolith
- **THEN** the effective cap is 200 — the same default the gateway enforces via `MAX_INGEST_ASSETS` on REST ingest

#### Scenario: Under-cap pushes unaffected

- **WHEN** a session carries at most the configured asset count
- **THEN** the push proceeds exactly as before (byte-size pre-flight, batching, retries unchanged)
