## Requirements

### Requirement: Original web URL stored in server resource records

The `ServerStorageAdapter` SHALL store the actual web URL of a downloaded resource as `original_url` in the server's Resource record, instead of the local file path. This enables the server-side `content_type_map` to correctly map web URLs to content types for HTML conversion fallback.

#### Scenario: Image resource upload with web URL

- **WHEN** the extension downloads an image from `https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/store-card-13-iphone-nav-202509?wid=400&fmt=png-alpha`
- **AND** the image handler generates the local filename `images/1_as-images.apple.com_is_store-card-13-iphone-nav-202509.png`
- **THEN** `ServerStorageAdapter.addFile()` sends the web URL `https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/store-card-13-iphone-nav-202509?wid=400&fmt=png-alpha` as `originalUrl` to the server
- **AND** `local_path` in the Resource record is `images/1_as-images.apple.com_is_store-card-13-iphone-nav-202509.png`

#### Scenario: Backward compatibility when no web URL is provided

- **WHEN** a caller invokes `addFile()` without an `originalUrl` parameter
- **THEN** the adapter falls back to using the local `path` as `originalUrl` (current behavior)
- **AND** the server stores `path` as `original_url` in the Resource record

### Requirement: IStorageAdapter supports optional original URL parameter

The `IStorageAdapter` interface SHALL accept an optional `originalUrl?: string` parameter in the `addFile()` method, defaulting to undefined when not provided.

#### Scenario: Image handler passes web URL to addFile

- **WHEN** the image handler in `images.ts` calls `storage.addFile(path, blob, contentType, originalSrc)`
- **THEN** the `IStorageAdapter` implementation receives the `originalUrl` value
- **AND** non-server adapters (JSZipAdapter, IndexedDBAdapter) ignore the parameter with no behavioral change
