## 1. Sniffer module

- [x] 1.1 Create `src/background/sniffImageMime.ts` exporting `async function sniffImageMimeType(blob: Blob): Promise<string | null>`
- [x] 1.2 Implement bounded read: `const buf = new Uint8Array(await blob.slice(0, 512).arrayBuffer())`; handle empty-blob case (length 0 → return null)
- [x] 1.3 Implement PNG signature check (`89 50 4E 47 0D 0A 1A 0A`) → `image/png`
- [x] 1.4 Implement JPEG signature check (`FF D8 FF`) → `image/jpeg`
- [x] 1.5 Implement GIF87a/GIF89a check (`47 49 46 38 37/39 61`) → `image/gif`
- [x] 1.6 Implement WebP check (bytes 0–3 = `RIFF`, bytes 8–11 = `WEBP`) → `image/webp`
- [x] 1.7 Implement BMP check (`42 4D`) → `image/bmp`
- [x] 1.8 Implement ICO check (`00 00 01 00`) → `image/x-icon`
- [x] 1.9 Implement AVIF check (bytes 4–11 = `ftypavif` or `ftypavis`) → `image/avif`
- [x] 1.10 Implement HEIC check (bytes 4–7 = `ftyp`, bytes 8–11 ∈ {`heic`,`heix`,`hevc`,`hevx`,`heim`,`heis`,`hevm`,`hevs`,`mif1`,`msf1`}) → `image/heic`
- [x] 1.11 Implement TIFF check (`49 49 2A 00` or `4D 4D 00 2A`) → `image/tiff`
- [x] 1.12 Implement SVG text sniff via `new TextDecoder('utf-8', { fatal: false }).decode(buf)` and regex `/<\?xml\b|<svg\b/i` → `image/svg+xml`
- [x] 1.13 Return `null` when no signature matches; wrap the entire body in try/catch so a read/decode error returns `null` without throwing

## 2. Sniffer unit tests

- [x] 2.1 Create `tests/unit/sniff-image-mime.test.ts` and wire it into the existing jest/vitest test runner used by other unit tests
- [x] 2.2 Add test: PNG header buffer → `"image/png"`
- [x] 2.3 Add test: JPEG header buffer → `"image/jpeg"`
- [x] 2.4 Add test: `GIF87a` and `GIF89a` header buffers → `"image/gif"`
- [x] 2.5 Add test: synthetic `RIFF....WEBP` header → `"image/webp"`
- [x] 2.6 Add test: `BM` header → `"image/bmp"`
- [x] 2.7 Add test: `00 00 01 00` header → `"image/x-icon"`
- [x] 2.8 Add test: `ftypavif` and `ftypavis` headers → `"image/avif"`
- [x] 2.9 Add test: `ftypheic`, `ftypheix`, `ftypmif1` headers → `"image/heic"`
- [x] 2.10 Add test: `II*\0` and `MM\0*` headers → `"image/tiff"`
- [x] 2.11 Add test: UTF-8 `"<?xml version=...<svg>..."` and `"<svg xmlns=...>"` bytes → `"image/svg+xml"`
- [x] 2.12 Add test: 0-byte blob → `null` (no throw)
- [x] 2.13 Add test: random non-image bytes → `null`

## 3. Image handler integration

- [x] 3.1 In `src/background/fileHandlers/images.ts`, import `sniffImageMimeType` from `../sniffImageMime`
- [x] 3.2 After reading the blob, compute `let contentType = result.response.headers.get('Content-Type') || ''`
- [x] 3.3 If `contentType === '' || contentType === 'application/octet-stream'`, call `const sniffed = await sniffImageMimeType(blob); if (sniffed) contentType = sniffed;`
- [x] 3.4 Keep the existing `generateImageFilename(fullImageUrl, contentType)` call unchanged — it already handles empty content-type by returning `.bin`
- [x] 3.5 Update the `storage.addFile` call from `storage.addFile(\`images/${filename}\`, blob)` to `storage.addFile(\`images/${filename}\`, blob, contentType || undefined)` so the server receives the detected MIME

## 4. Image handler tests

- [x] 4.1 Add a test case under an appropriate `tests/unit/*.test.ts` (new file if needed, e.g. `tests/unit/image-handler-sniff.test.ts`) that stubs `RequestQueue.enqueue` to deliver an opaque-like `Response` (empty `Content-Type`) whose `.blob()` yields PNG magic bytes
- [x] 4.2 Assert that `filenameMap` ends up mapping the source URL to a path ending in `.png`
- [x] 4.3 Assert that `storage.addFile` is invoked with third argument `"image/png"`
- [x] 4.4 Add negative test: unreadable sniff (random bytes, empty Content-Type) → filename ends in `.bin` and `addFile` called with `undefined` content-type
- [x] 4.5 Add regression test: response with `Content-Type: image/webp` is NOT sniffed — spy on `sniffImageMimeType` to confirm not called — and filename ends in `.webp`

## 5. Validation

- [x] 5.1 Run the project's unit-test command (e.g. `npm test` / `./run-tests.sh`) and ensure all new and existing tests pass
- [x] 5.2 Run `npm run lint` (or project-equivalent) on touched files and fix any issues
- [x] 5.3 Run `openspec validate sniff-image-mime-type --strict` and resolve any findings
- [ ] 5.4 Manual verification (optional but recommended): run a server-mode download against a page containing the Apple store CDN image URL from the bug report and confirm the HTML now contains `..._icon-product-mac.png` rather than `.bin`
