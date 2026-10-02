## ADDED Requirements

### Requirement: Filename extension map fallback for bin extensions

When the filename map lookup fails and `generate_image_filename()` produces a filename ending with `.bin`, the converter SHALL attempt to look up the filename's base (without the `.bin` extension) in the `filename_ext_map`. If a match is found, the converter SHALL use the matched extension instead of `.bin`.

#### Scenario: Bin filename corrected via filename_ext_map

- **WHEN** an `<img src>` URL is not in the filename map and not in the content-type map, producing the filename `1_as-images.apple.com_is_store-card-13-iphone-nav-202509.bin`
- **AND** the `filename_ext_map` contains `"1_as-images.apple.com_is_store-card-13-iphone-nav-202509"` → `"png"`
- **THEN** the converter uses `1_as-images.apple.com_is_store-card-13-iphone-nav-202509.png` as the filename

#### Scenario: No match in filename_ext_map preserves bin

- **WHEN** `generate_image_filename()` produces a `.bin` filename
- **AND** the filename base is not found in the `filename_ext_map`
- **THEN** the `.bin` extension is used (unchanged behavior)

### Requirement: Filename extension map threaded through all image fallback paths

The `filename_ext_map` SHALL be used in ALL image URL conversion fallback paths where `generate_image_filename()` is called: `<img src>`, lazy-load attributes (`data-src`, `data-lazy-src`, etc.), `srcset` entries, `<source src>`, and CSS `url()` references in inline styles and `<style>` tags.

#### Scenario: Lazy-load attribute fallback corrects bin

- **WHEN** a `data-src` attribute produces a `.bin` filename via the fallback path
- **AND** the `filename_ext_map` contains a matching base name entry
- **THEN** the correct extension from the map is used instead of `.bin`

#### Scenario: CSS url() fallback corrects bin

- **WHEN** a CSS `url()` reference produces a `.bin` filename via the fallback path
- **AND** the `filename_ext_map` contains a matching base name entry
- **THEN** the correct extension from the map is used instead of `.bin`
