# HTML Processing Specification

## Purpose

HTML processing for the Website Downloader extension. The extension uploads raw HTML content to the server; all URL conversion, base64 inlining, merging, and assembly is handled server-side.

## Requirements

### Requirement: No client-side HTML processing

The extension SHALL NOT perform client-side HTML processing. All HTML transformation (URL-to-relative-path conversion, base64 inlining, HTML merging, incremental assembly, base tag removal) SHALL be performed by the server during ZIP assembly. The extension's responsibility is limited to:

1. Capturing raw HTML from the page DOM during scrolling
2. Uploading HTML chunks to the server via the storage adapter
3. Signaling scrape completion to trigger server-side processing

#### Scenario: Extension uploads raw HTML; server transforms it

- **WHEN** a page download runs
- **THEN** the extension captures raw HTML from the page DOM during scrolling, uploads the HTML chunks to the server via the storage adapter, and signals scrape completion to trigger server-side processing
- **AND** no HTML transformation (URL-to-relative-path conversion, base64 inlining, HTML merging, incremental assembly, base tag removal) is performed client-side — all of it is performed by the server during ZIP assembly
