## REMOVED Requirements

### Requirement: ZIP Mode URL Conversion
**Reason**: Client-side URL conversion removed. The server handles all URL-to-relative-path conversion during ZIP assembly.
**Migration**: Delete `html-converter.ts` and all converter modules (`link-converter.ts`, `image-converter.ts`, `background-image-converter.ts`, `object-converter.ts`, `style-converter.ts`, `script-converter.ts`). Delete `htmlUtils.ts` barrel file.

### Requirement: Single-File Mode Base64 Inlining
**Reason**: Client-side base64 inlining removed. Server handles single-file inlining during assembly.
**Migration**: Delete `convertToSingleFileHtml()` from `html-converter.ts`. No replacement needed.

### Requirement: HTML Merging
**Reason**: Client-side HTML merging removed. Server merges HTML chunks during assembly.
**Migration**: Delete `merge-html.ts` and `HtmlAssembler.ts`. No replacement needed.

### Requirement: Incremental HTML Assembly
**Reason**: Client-side incremental assembly removed. HTML chunks are streamed to the server, which handles assembly.
**Migration**: Delete `mergeHtmlIncremental()` and `finalizeIncrementalMerge()`. The `SCROLL_AND_EXTRACT_DIFF` handler uploads chunks directly to server.

### Requirement: Stale Assembly Job Cleanup
**Reason**: Client-side assembly jobs no longer exist. Server manages its own session cleanup.
**Migration**: Delete `cleanupIncrementalMerges()`. No replacement needed.

### Requirement: Base Tag Removal
**Reason**: Server handles `<base>` tag removal during assembly.
**Migration**: No client-side code needed. Server already handles this.
