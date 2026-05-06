## MODIFIED Requirements

### Requirement: Assembly pipeline phases
The ZIP assembly pipeline SHALL include a Phase 3b (CSS inlining) between Phase 3 (CSS URL conversion) and Phase 4 (output assembly). This phase inlines CSS content into the HTML for `file://` protocol compatibility.

#### Scenario: Multi-file ZIP assembly with CSS inlining
- **WHEN** a non-single-file session is assembled
- **THEN** Phase 3b runs after CSS URL conversion and before ZIP creation
- **AND** all `<link rel="stylesheet">` tags in the main HTML are replaced with inline `<style>` tags
- **AND** linked page HTMLs also have their stylesheets inlined

#### Scenario: Single-file mode skips Phase 3b
- **WHEN** a single-file session is assembled
- **THEN** Phase 3b is skipped (single-file mode already inlines all resources via a different mechanism)
