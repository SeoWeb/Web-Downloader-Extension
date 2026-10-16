## MODIFIED Requirements

### Requirement: Cloud-only assembly branch
When a session has a verified cloud binding (`pagepocket_user_id` set server-side, per `cloud-push-authorization`), the assembly pipeline SHALL skip ZIP/HTML file creation and instead push the processed data to PagePocket via gRPC after completing phases 1-3 (HTML merge, URL conversion, CSS conversion). The push SHALL carry the identity and plan resolved from the server-side binding, in bounded parallel batches per `assembly-timeout-envelope`.

#### Scenario: Cloud-only session with ZIP mode
- **WHEN** a session has a verified `pagepocket_user_id` binding and `singleFile` is false
- **THEN** the assembler SHALL complete HTML merging, URL conversion, CSS conversion, and CSS inlining as normal
- **AND** SHALL NOT create a ZIP file
- **AND** SHALL encode the processed `main_html` as UTF-8 bytes
- **AND** SHALL read all session resources from disk with their processed content
- **AND** SHALL append linked page HTML files as assets with `pages/` prefixed paths
- **AND** SHALL call `push_to_archive()` with the bound user ID, the bound user's plan, session ID, URL, title, processed HTML, and all assets
- **AND** SHALL set `session.status = "ready"`, `session.cloud_page_id` to the returned page ID
- **AND** SHALL NOT set `session.zip_path`

#### Scenario: Cloud-only session with single-file mode
- **WHEN** a session has a verified `pagepocket_user_id` binding and `singleFile` is true
- **THEN** the assembler SHALL produce the single-file HTML with all resources inlined
- **AND** SHALL read the resulting HTML from disk
- **AND** SHALL call `push_to_archive()` with the inlined HTML and no assets
- **AND** SHALL delete the local HTML file after successful push
- **AND** SHALL set `session.status = "ready"`, `session.cloud_page_id`
- **AND** SHALL NOT set `session.zip_path`

#### Scenario: Push carries the authoritative plan
- **WHEN** the push request is constructed
- **THEN** `plan` is set from the server-side binding (never omitted, never client-supplied)
- **AND** the archived page is quota-tracked under the user's real plan

#### Scenario: Cloud push failure
- **WHEN** `push_to_archive()` returns an error after all retry attempts
- **THEN** the assembler SHALL set `session.cloud_status = "failed"` and `session.cloud_error` to the error message
- **AND** SHALL set `session.status = "ready"` (so the extension can read the error)
- **AND** SHALL NOT set `session.zip_path`

## ADDED Requirements

### Requirement: Duplicate archive paths are deduplicated deterministically
When two resources in a session resolve to the same archive path (e.g., identical basenames from different directories), the ZIP assembler SHALL deterministically disambiguate the collision (consistent hash-suffixed filename) for BOTH the stored file and the HTML references, so no resource silently overwrites another.

#### Scenario: Same-basename assets from different directories both appear
- **WHEN** a session contains `a/banner.png` and `b/banner.png` mapping to the archive path `banner.png`
- **THEN** the ZIP contains two distinct entries (one disambiguated with a deterministic suffix)
- **AND** each HTML reference points at the correct entry

#### Scenario: Disambiguation is stable across assemblies
- **WHEN** the same session is assembled twice
- **THEN** the generated archive paths are identical (no timestamp/randomness in the suffix)
