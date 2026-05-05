## MODIFIED Requirements

### Requirement: Filename extension map fallback for bin extensions

When the filename map lookup fails and `generate_image_filename()` produces a filename ending with `.bin`, the converter SHALL attempt to look up the filename's base (without the `.bin` extension) in the `filename_ext_map`. If a match is found, the converter SHALL use the matched extension instead of `.bin`.

The generated base name MUST include the DJB2 query hash when the original URL has query parameters, matching the extension's filename generation so that `filename_ext_map` keys (built from actual stored resource paths) are found.

#### Scenario: Bin filename corrected via filename_ext_map

- **WHEN** an `<img src>` URL is not in the filename map and not in the content-type map, producing the filename `1_as-images.apple.com_is_store-card-13-iphone-nav-202509.bin`
- **AND** the `filename_ext_map` contains `"1_as-images.apple.com_is_store-card-13-iphone-nav-202509"` → `"png"`
- **THEN** the converter uses `1_as-images.apple.com_is_store-card-13-iphone-nav-202509.png` as the filename

#### Scenario: No match in filename_ext_map preserves bin

- **WHEN** `generate_image_filename()` produces a `.bin` filename
- **AND** the filename base is not found in the `filename_ext_map`
- **THEN** the `.bin` extension is used (unchanged behavior)

#### Scenario: Query-hashed base name found in filename_ext_map

- **WHEN** the extension downloaded an image from `https://cdn.example.com/api/image/123?width=200` and stored it as `images/api_image_123_a1b2c3d4.jpg`
- **AND** the `filename_ext_map` contains `"api_image_123_a1b2c3d4"` → `"jpg"`
- **AND** the server fallback generates `api_image_123_a1b2c3d4.bin` (with query hash)
- **THEN** `_maybe_fix_bin_extension()` finds the match and replaces `.bin` with `.jpg`
