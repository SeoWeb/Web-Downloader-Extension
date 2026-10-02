# HTML Processing Specification

## Purpose

HTML processing for the Website Downloader extension. The extension uploads raw HTML content to the server; all URL conversion, base64 inlining, merging, and assembly is handled server-side.

## Requirements

No client-side HTML processing requirements remain. All HTML transformation (URL-to-relative-path conversion, base64 inlining, HTML merging, incremental assembly, base tag removal) is performed by the server during ZIP assembly. The extension's responsibility is limited to:

1. Capturing raw HTML from the page DOM during scrolling
2. Uploading HTML chunks to the server via the storage adapter
3. Signaling scrape completion to trigger server-side processing
