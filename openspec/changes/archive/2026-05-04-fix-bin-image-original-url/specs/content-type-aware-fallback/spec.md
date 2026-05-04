## ADDED Requirements

### Requirement: Local-path-based extension map construction

The assembler SHALL build a `filename_ext_map` from resources' `local_path` values, mapping each image resource's sanitized base filename (without extension) to the correct image extension derived from its `content_type`. This map serves as a secondary safety net when the URL-based `content_type_map` lookup fails but a resource file exists on disk with a matching base name.

#### Scenario: Map built from image resources on disk

- **WHEN** a session has a resource with `local_path` = `images/1_as-images.apple.com_is_store-card-13-iphone-nav-202509.png` and `content_type` = `image/png`
- **THEN** the `filename_ext_map` contains the entry `"1_as-images.apple.com_is_store-card-13-iphone-nav-202509"` → `"png"`

#### Scenario: Non-image resources excluded from map

- **WHEN** a session has a resource with `local_path` = `styles/main.css` or `local_path` not starting with `images/`
- **THEN** that resource is excluded from the `filename_ext_map`

#### Scenario: Resources without content-type excluded from map

- **WHEN** a session has a resource with `content_type` = `None`
- **THEN** that resource is excluded from the `filename_ext_map`

#### Scenario: Map passed to HTML converter

- **WHEN** the assembler invokes `html_converter_service.convert_html()`
- **THEN** the `filename_ext_map` is passed as the `filename_ext_map` parameter
