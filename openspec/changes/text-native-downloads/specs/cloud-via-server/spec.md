## ADDED Requirements

### Requirement: Cloud push carries text formats

The cloud-push branch SHALL stop ignoring the text-format options: when markdown is enabled it SHALL convert and push the markdown document (same converter as the zip path); when content-as-text is enabled it SHALL push the uploaded text; when HTML is deselected it SHALL push only the text document(s), with `html_content` empty. Linked-page text documents SHALL be pushed with their pages where the ingest schema supports them.

#### Scenario: Markdown pushed to cloud

- **WHEN** a cloud-push session completes with HTML + markdown selected
- **THEN** the pushed page contains both the HTML content and the markdown document

#### Scenario: Text-only push

- **WHEN** a cloud-push session completes with HTML deselected and markdown selected
- **THEN** the push carries the markdown document and no `html_content`

### Requirement: Format options reach the assembler

Session-create options SHALL include `downloadHtml` and `downloadContentAsText` (alongside the existing `singleFile` and `downloadContentAsMarkdown`) so assembly and cloud push can honor the user's selection.

#### Scenario: Options propagated

- **WHEN** the extension creates a session with HTML off and content-as-text on
- **THEN** the session's stored options reflect `downloadHtml=false` and `downloadContentAsText=true`
