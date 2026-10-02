## Why

Images fetched in server mode from third-party CDNs (e.g. `store.storeimages.cdn-apple.com`) are saved with a `.bin` extension whenever (a) the URL path has no image extension in its last segment and (b) the HTTP response is opaque (cross-origin `no-cors` fallback in `RequestQueue`), which hides all response headers — including `Content-Type`. The resulting HTML references broken assets like `../images/1_as-images.apple.com_is_icon-product-mac.bin` that browsers refuse to display as images. The existing server-side `content-type-aware-fallback` cannot help because the extension never supplies a real MIME to the server; `ServerStorageAdapter.addFile` is also called without a MIME argument, so `Resource.content_type` is persisted as `application/octet-stream`.

## What Changes

- Introduce a client-side MIME sniffer that inspects the first bytes of an image blob and returns a canonical MIME string (`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/bmp`, `image/x-icon`, `image/avif`, `image/heic`, `image/tiff`, `image/svg+xml`) based on magic-byte signatures, with a text-based fallback for SVG.
- In the image download path (`addImageFiles`), when the fetched response's `Content-Type` is missing or equals `application/octet-stream`, run the sniffer over the blob and use its result as the effective content-type for filename generation.
- Pass the effective content-type through to `storage.addFile(path, blob, contentType)` so that `ServerStorageAdapter` forwards a real MIME to the server instead of defaulting to `application/octet-stream`, enabling the existing server-side `content-type-aware-fallback` paths.
- No change to filename generation rules, URL parsing, or the server-side HTML converter; the fix is strictly about populating content-type before `generateImageFilename` runs.

## Capabilities

### New Capabilities

- `image-mime-sniffing`: Client-side detection of image MIME type from blob contents by magic-byte signature (and SVG text sniff), used to recover a correct file extension when the HTTP `Content-Type` header is absent or unhelpful (e.g. opaque cross-origin responses). Also governs passing the detected MIME through the storage layer to the server.

### Modified Capabilities

(none — the new capability is additive; existing specs do not describe client-side image MIME detection)

## Impact

- Affected code:
  - `src/background/fileHandlers/images.ts` (invoke sniffer, pass content-type to storage)
  - `src/background/sniffImageMime.ts` (new module)
  - Tests under `tests/` for the sniffer and the image handler
- No changes to public APIs, network protocols, server, or database schema.
- No user-visible UI changes. Fix is transparent: previously-broken image references become valid after the fix.
- Regression risk is localized — existing images with readable `Content-Type` or a URL extension are unaffected; the sniffer is only consulted as a fallback.
