## MODIFIED Requirements

### Requirement: Assembly pipeline phases
The ZIP assembly pipeline SHALL include a Phase 3b (CSS inlining) between Phase 3 (CSS URL conversion) and Phase 4 (output assembly). This phase inlines CSS content into the HTML for `file://` protocol compatibility.

#### Scenario: Multi-file ZIP assembly with CSS inlining
- **WHEN** a non-single-file session is assembled
- **THEN** Phase 3b runs after CSS URL conversion and before ZIP creation
- **AND** a `local_path_to_storage` mapping is built from all session resources (mapping logical paths like `styles/main.css` to UUID-based disk paths)
- **AND** this mapping is passed to `inline_css_into_html()` so it can resolve CSS files on disk
- **AND** all `<link rel="stylesheet">` tags in the main HTML are replaced with inline `<style>` tags
- **AND** linked page HTMLs also have their stylesheets inlined

#### Scenario: Single-file mode uses storage path mapping
- **WHEN** a single-file session is assembled
- **THEN** the `local_path_to_storage` mapping is passed to `write_single_file_to_disk()` so it can resolve all resource types (CSS, JS, images) for base64 inlining

#### Scenario: Single-file mode skips Phase 3b
- **WHEN** a single-file session is assembled
- **THEN** Phase 3b is skipped (single-file mode already inlines all resources via a different mechanism)

### Requirement: CSS files still included in ZIP
The server SHALL continue writing CSS files to the `styles/` directory in the ZIP, even after inlining them into HTML, for completeness and fallback purposes.

#### Scenario: CSS files present in ZIP alongside inline styles
- **WHEN** ZIP assembly completes for a multi-file session
- **THEN** the ZIP contains both inline `<style>` tags in `index.html` AND the original CSS files in `styles/` directory
