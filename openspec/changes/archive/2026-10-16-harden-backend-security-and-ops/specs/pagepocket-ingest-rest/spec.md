## MODIFIED Requirements

### Requirement: Multipart form field mapping
The REST endpoint SHALL map `multipart/form-data` fields to the gRPC `IngestPageRequest` message as follows. The `plan` form field is REMOVED from the contract: the plan SHALL come exclusively from the authenticated JWT claim, and any client-supplied `plan` value SHALL be ignored (and rejected by validation).

| Form Field | gRPC Field | Type | Required |
|---|---|---|---|
| `url` | `url` | string (Form) | Yes |
| `title` | `title` | string (Form) | No |
| `html_content` | `html_content` | bytes (File) | Yes |
| `extension_job_id` | `extension_job_id` | string (Form) | No |
| `assets` | `assets[]` | repeated Asset (Files) | No |

#### Scenario: Plan always comes from the JWT claim
- **GIVEN** a user with plan "free" in their JWT
- **WHEN** the upload request includes a `plan` field with any value (e.g., `pro`)
- **THEN** the gateway ignores the field (or rejects the request as invalid)
- **AND** the gRPC request's plan is `free` — the JWT claim — never the client-supplied value

#### Scenario: Asset file metadata preserved
- **GIVEN** an asset file uploaded with filename `style.css` and content-type `text/css`
- **WHEN** the gateway constructs the asset protobuf
- **THEN** `filename` is set to `style.css`
- **AND** `content_type` is set to `text/css`
- **AND** `data` contains the file bytes
