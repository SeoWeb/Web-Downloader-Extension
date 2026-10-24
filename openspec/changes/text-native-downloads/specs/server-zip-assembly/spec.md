## ADDED Requirements

### Requirement: Pure-text output modes

The zip assembler SHALL support assembling an artifact without `index.html` when HTML is deselected and only text formats are active. The artifact SHALL contain one file per selected text format per page (main and linked), and no HTML-only extras (rewritten assets bundles for HTML rendering).

#### Scenario: Text-only assembly

- **WHEN** a session completes with `download_html=false` and markdown enabled
- **THEN** the artifact contains only markdown documents and no `index.html`

### Requirement: Raw delivery of single-file artifacts

When the artifact consists of exactly one top-level file, the session result SHALL be that file raw (`.html`, `.md`, or `.txt`) with a matching filename and MIME type; the `zip` container SHALL be used only for multi-file artifacts.

#### Scenario: Single text file raw

- **WHEN** assembly produces exactly one `content.md`
- **THEN** the session's output is that markdown file, not a zip containing it

#### Scenario: Single html unchanged

- **WHEN** singleFile mode produces one self-contained HTML document
- **THEN** it continues to be delivered as a raw `.html` as today
