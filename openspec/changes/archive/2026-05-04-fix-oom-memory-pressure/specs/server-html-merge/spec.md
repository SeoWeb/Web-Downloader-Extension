## MODIFIED Requirements

### Requirement: HTML Complexity Analysis (updated)
The server SHALL analyze HTML complexity using per-document analysis to detect potential exponential growth scenarios before merging.

#### Scenario: Excessive element count detected (unchanged)
- **WHEN** the combined element count across skeleton and all chunks exceeds 100,000 elements
- **THEN** the server uses the safe merge strategy instead of DOM-based merging

#### Scenario: Deeply nested structure detected (updated)
- **WHEN** ANY individual document (skeleton or any chunk file) contains elements with more than 50 levels of nesting
- **THEN** the server uses the safe merge strategy

#### Scenario: Large table detected (updated)
- **WHEN** ANY individual document (skeleton or any chunk file) contains a table with more than 5,000 rows
- **THEN** the server uses the safe merge strategy

#### Scenario: Excessive nested tables (updated)
- **WHEN** ANY individual document (skeleton or any chunk file) contains more than 10 nested tables
- **THEN** the server uses the safe merge strategy

#### Scenario: Early-exit on element threshold (new)
- **WHEN** the running element count total exceeds 100,000 during per-chunk counting
- **THEN** the server immediately returns `is_complex=True` without processing remaining chunks
