## ADDED Requirements

### Requirement: Image MIME sniffer for blob contents

The system SHALL provide a client-side sniffer that accepts an image `Blob` and returns a canonical MIME type string derived from the blob's leading bytes, or `null` when no recognized signature is found.

The sniffer SHALL read only the first 512 bytes of the blob to keep CPU and memory usage bounded, and SHALL be an asynchronous function (`async (blob: Blob) => Promise<string | null>`).

The sniffer SHALL recognize the following binary signatures and return the paired MIME type:

| Format | Leading bytes (hex) | Returned MIME |
|---|---|---|
| PNG | `89 50 4E 47 0D 0A 1A 0A` | `image/png` |
| JPEG | `FF D8 FF` | `image/jpeg` |
| GIF | `47 49 46 38 37 61` or `47 49 46 38 39 61` | `image/gif` |
| WebP | `52 49 46 46 ?? ?? ?? ?? 57 45 42 50` | `image/webp` |
| BMP | `42 4D` | `image/bmp` |
| ICO | `00 00 01 00` | `image/x-icon` |
| AVIF | bytes 4–11 `66 74 79 70 61 76 69 (66\|73)` (`ftypavif` / `ftypavis`) | `image/avif` |
| HEIC | bytes 4–11 `66 74 79 70` followed by `heic` / `heix` / `hevc` / `hevx` / `heim` / `heis` / `hevm` / `hevs` / `mif1` / `msf1` | `image/heic` |
| TIFF | `49 49 2A 00` or `4D 4D 00 2A` | `image/tiff` |

When no binary signature matches, the sniffer SHALL attempt a text sniff by decoding the first 512 bytes as UTF-8 (with replacement on invalid sequences) and returning `image/svg+xml` when the decoded text matches the regex `/<\?xml\b|<svg\b/i`. Otherwise the sniffer SHALL return `null`.

The sniffer MUST NOT throw on empty blobs, unreadable blobs, or malformed contents; it returns `null` in those cases.

#### Scenario: PNG signature is detected

- **WHEN** the sniffer is called with a blob whose first 8 bytes are `89 50 4E 47 0D 0A 1A 0A`
- **THEN** it returns `"image/png"`

#### Scenario: JPEG signature is detected

- **WHEN** the sniffer is called with a blob whose first 3 bytes are `FF D8 FF`
- **THEN** it returns `"image/jpeg"`

#### Scenario: GIF87a and GIF89a signatures are detected

- **WHEN** the sniffer is called with a blob beginning with `GIF87a` or `GIF89a`
- **THEN** it returns `"image/gif"`

#### Scenario: WebP signature with RIFF/WEBP chunks is detected

- **WHEN** the sniffer is called with a blob whose first 4 bytes are `52 49 46 46` ("RIFF") and whose bytes 8–11 are `57 45 42 50` ("WEBP")
- **THEN** it returns `"image/webp"`

#### Scenario: BMP signature is detected

- **WHEN** the sniffer is called with a blob whose first 2 bytes are `42 4D` ("BM")
- **THEN** it returns `"image/bmp"`

#### Scenario: ICO signature is detected

- **WHEN** the sniffer is called with a blob whose first 4 bytes are `00 00 01 00`
- **THEN** it returns `"image/x-icon"`

#### Scenario: AVIF ftyp box is detected

- **WHEN** the sniffer is called with a blob whose bytes 4–11 spell `ftypavif` or `ftypavis`
- **THEN** it returns `"image/avif"`

#### Scenario: HEIC ftyp box is detected

- **WHEN** the sniffer is called with a blob whose bytes 4–7 spell `ftyp` and whose bytes 8–11 are one of `heic`, `heix`, `hevc`, `hevx`, `heim`, `heis`, `hevm`, `hevs`, `mif1`, `msf1`
- **THEN** it returns `"image/heic"`

#### Scenario: TIFF signatures are detected

- **WHEN** the sniffer is called with a blob whose first 4 bytes are `49 49 2A 00` (little-endian) or `4D 4D 00 2A` (big-endian)
- **THEN** it returns `"image/tiff"`

#### Scenario: SVG text signature is detected

- **WHEN** no binary signature matches **AND** the first 512 bytes decoded as UTF-8 contain `<svg` or `<?xml`
- **THEN** the sniffer returns `"image/svg+xml"`

#### Scenario: Unknown content returns null

- **WHEN** the sniffer is called with a blob whose leading bytes match none of the known binary signatures and whose text sniff does not match SVG
- **THEN** the sniffer returns `null`

#### Scenario: Empty blob returns null without throwing

- **WHEN** the sniffer is called with a zero-byte blob
- **THEN** it returns `null`
- **AND** no exception is thrown

### Requirement: Content-type recovery for fetched images

When downloading an image in the extension's image handler (`addImageFiles`), the system SHALL use the sniffer to recover a MIME type whenever the HTTP response's `Content-Type` header is absent, empty, or equal to `application/octet-stream`. The recovered MIME SHALL be used as the `contentType` argument passed to `generateImageFilename`.

If the sniffer also returns `null`, the image handler SHALL fall back to the existing behavior (extension becomes `.bin`), without aborting the download.

#### Scenario: Opaque response with PNG body recovers correct extension

- **WHEN** an image is fetched via the `no-cors` fallback producing an opaque response (`Content-Type` unreadable)
- **AND** the downloaded blob's first 8 bytes are the PNG magic number
- **THEN** the sniffer returns `"image/png"`
- **AND** the generated filename ends in `.png`, not `.bin`

#### Scenario: Response with application/octet-stream Content-Type is re-sniffed

- **WHEN** an image is fetched with `Content-Type: application/octet-stream`
- **AND** the blob is a valid JPEG
- **THEN** the sniffer is consulted and returns `"image/jpeg"`
- **AND** the generated filename ends in `.jpg`

#### Scenario: Readable image Content-Type is honored without sniffing

- **WHEN** an image is fetched with `Content-Type: image/webp`
- **THEN** the sniffer is NOT invoked
- **AND** the generated filename ends in `.webp`

#### Scenario: Sniff miss preserves legacy .bin fallback

- **WHEN** an image is fetched, `Content-Type` is missing, and the sniffer returns `null`
- **THEN** `generateImageFilename` is called with an empty content-type
- **AND** the generated filename ends in `.bin` (unchanged behavior)
- **AND** the download is not aborted

### Requirement: Sniffed MIME is forwarded to storage

When the image handler determines an effective content-type (from the response header or from the sniffer), it SHALL pass that content-type as the third argument to `storage.addFile(path, blob, contentType)` so that the server receives a real MIME on the resource upload. Callers SHALL NOT rely on `blob.type` alone, because opaque responses expose an empty `blob.type`.

#### Scenario: Sniffed MIME reaches ServerStorageAdapter

- **WHEN** the image handler has sniffed a blob and determined `"image/png"`
- **THEN** `storage.addFile` is invoked with `contentType = "image/png"`
- **AND** `ServerStorageAdapter` uploads the resource to the server with `Content-Type: image/png` rather than `application/octet-stream`

#### Scenario: Header-provided MIME reaches ServerStorageAdapter

- **WHEN** the image handler reads `Content-Type: image/jpeg` from the response
- **THEN** `storage.addFile` is invoked with `contentType = "image/jpeg"`

#### Scenario: Sniffer miss forwards empty/undefined content-type

- **WHEN** the image handler cannot determine a MIME (header unreadable, sniffer null)
- **THEN** `storage.addFile` is invoked without a content-type (or with `undefined`)
- **AND** existing `ServerStorageAdapter` defaulting behavior (`application/octet-stream`) applies
