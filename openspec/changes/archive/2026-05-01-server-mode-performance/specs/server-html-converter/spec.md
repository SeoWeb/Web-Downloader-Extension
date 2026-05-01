## MODIFIED Requirements

### Requirement: Single-Parse HTML Conversion

The HTML converter SHALL parse the input HTML exactly once with BeautifulSoup and apply all element-type conversions on the same parsed soup tree, instead of parsing the HTML independently for each conversion pass. This eliminates 6 redundant parses per page.

#### Scenario: HTML parsed once for all conversions
- **GIVEN** `convert_html` is called with an HTML string
- **WHEN** the conversion executes
- **THEN** BeautifulSoup parses the HTML exactly once
- **AND** all 7 conversion passes (remove base, links, images, background images, objects, stylesheets, scripts) operate on the same soup object
- **AND** the output is produced by serializing the soup once with `str(soup)`

#### Scenario: Conversion order preserved
- **GIVEN** single-parse conversion is active
- **WHEN** the conversion passes execute
- **THEN** the order is: remove base tag → convert links → convert images → convert background images → convert objects → convert stylesheets → convert scripts
- **AND** this order matches the previous sequential parse implementation

#### Scenario: Output identical to multi-parse implementation
- **GIVEN** the same HTML input and filename map
- **WHEN** comparing single-parse output to the previous multi-parse output
- **THEN** the converted HTML is identical in content and structure

### Requirement: Single-Parse Linked Page Conversion

The linked page HTML converter SHALL use the same single-parse approach, parsing once and applying all conversions on the shared soup tree with the `../` path prefix for linked pages.

#### Scenario: Linked page parsed once
- **GIVEN** `convert_linked_page_html` is called
- **WHEN** the conversion executes
- **THEN** the HTML is parsed exactly once
- **AND** all conversion passes use the `../` path prefix appropriate for the `pages/` directory
