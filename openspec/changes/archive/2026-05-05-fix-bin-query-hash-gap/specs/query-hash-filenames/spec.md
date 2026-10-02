## ADDED Requirements

### Requirement: DJB2 query hash in server-side image filename generation

The server's `generate_image_filename()` SHALL compute a DJB2 hash of the URL's query string and append it to the base filename when query parameters are present, producing the same 8-character zero-padded hex string as the extension's TypeScript `getQueryHash()` function.

#### Scenario: URL with query parameters includes hash in filename

- **WHEN** `generate_image_filename()` is called with `original_url = "https://cdn.example.com/api/image/123?width=200&fmt=jpeg"` and no content-type
- **THEN** the generated filename includes an 8-char hex query hash suffix (e.g. `api_image_123_<hash>.bin`)

#### Scenario: URL without query parameters produces no hash

- **WHEN** `generate_image_filename()` is called with `original_url = "https://cdn.example.com/api/image/123"` (no query params)
- **THEN** the generated filename has no hash suffix (e.g. `api_image_123.bin`)

#### Scenario: Hash matches TypeScript implementation exactly

- **WHEN** the Python DJB2 hash is computed for query string `"?width=200"`
- **THEN** the result is identical to the TypeScript `getQueryHash()` output for the same input
