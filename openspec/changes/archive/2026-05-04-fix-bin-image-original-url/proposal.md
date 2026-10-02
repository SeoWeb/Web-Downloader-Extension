## Why

The server-side `content_type_map` fallback (added by `fix-bin-image-extensions`) produces `.bin` extensions for images because `ServerStorageAdapter.addFile()` sets `originalUrl` to the local file path (e.g., `images/foo.png`) instead of the actual web URL. This means `_lookup_content_type()` can never match a web URL against the map, so `generate_image_filename()` defaults to `.bin`. The client-side MIME sniffing (added by `sniff-image-mime-type`) correctly generates filenames with proper extensions, but when the `filename_map` lookup misses for any reason, the fallback is broken.

## What Changes

- **Fix `ServerStorageAdapter.addFile()`**: Accept and forward the actual web URL as `originalUrl` instead of the local file path, so the server's `content_type_map` maps web URLs → content types correctly.
- **Add `IStorageAdapter.addFile()` optional `originalUrl` parameter**: Backward-compatible interface change so callers can pass the original web URL.
- **Pass web URLs from image handler**: `images.ts` passes the source URL to `storage.addFile()`.
- **Add `local_path`-based safety net**: The server-side assembler also indexes `content_type_map` by `local_path` and provides a `filename_ext_map` for the converter's fallback path, so when `generate_image_filename()` produces `.bin`, the converter can still find the correct extension from disk-stored resources.

## Capabilities

### New Capabilities
- `server-storage-original-url`: ServerStorageAdapter stores the actual web URL as a resource's `original_url` so the server can correctly map URLs to content types during HTML conversion.

### Modified Capabilities
- `content-type-aware-fallback`: Content-type map now also indexes by `local_path` and exposes a `filename_ext_map` derived from stored resource paths, so the fallback can recover the correct extension even when web URL lookup misses.
- `server-html-converter`: HTML converter's image URL fallback paths use the new `filename_ext_map` when a `.bin` extension would otherwise be generated, matching against the extension-derived local_path from uploaded resources.

## Impact

- **Extension**: `storage-adapter.ts` (interface), `server-storage-adapter.ts` (implementation), `fileHandlers/images.ts` (caller)
- **Server**: `zip_assembler.py` (map construction), `html_converter.py` (converter fallback paths)
- No API or protocol changes — the `originalUrl` field in the resource upload endpoint already exists
