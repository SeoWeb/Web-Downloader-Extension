## MODIFIED Requirements

### Requirement: ZIP Mode URL Conversion

The system SHALL convert all resource URLs in the HTML to relative local paths for ZIP archive packaging. In server mode, URL conversion is performed by the server using the uploaded filename map; in local mode, it is performed by the extension.

#### Scenario: Server mode URL conversion

- GIVEN server mode is active and the session is being finalized
- WHEN the server performs URL conversion on the merged HTML
- THEN the server uses the uploaded filename map and resource metadata to convert URLs
- AND the converted HTML is included in the ZIP without client-side conversion

#### Scenario: Server mode CSS file URL conversion

- GIVEN server mode is active and the session is being finalized
- WHEN the server processes CSS files stored at `styles/`
- THEN the server converts `url()` references inside CSS files to relative local paths
- AND CSS `url()` references to images use `../images/` prefix (CSS is in `styles/`, images in `images/`)
- AND data URIs and already-relative paths are left unchanged

#### Scenario: Server mode linked page URL conversion

- GIVEN server mode is active and linked page HTML is being converted
- WHEN the server performs URL conversion on a linked page's merged HTML
- THEN all resource URLs use `../` prefix (images → `../images/`, CSS → `../styles/`, JS → `../scripts/`)
- AND the linked page uses the session's global filename map including incremental updates

#### Scenario: Local mode URL conversion

- GIVEN local mode is active
- WHEN the extension performs URL conversion on the HTML
- THEN the existing client-side html-utils converters are used
- AND the converted HTML is stored in IndexedDB

### Requirement: HTML Merging for Scrolled Pages

The system SHALL merge HTML content from multiple scroll positions into a single document. In server mode, HTML chunks are sent to the server for merging; in local mode, merging happens in the browser.

#### Scenario: Server mode HTML chunk streaming

- GIVEN server mode is active and the page is being scrolled
- WHEN each scroll cycle captures new HTML
- THEN the HTML chunk is uploaded to the server immediately
- **AND** after all scrolling is complete, the extension sends the scrape-complete signal
- **AND** the server handles incremental merging upon finalization
- **AND** linked page HTML is uploaded separately with `pageType: "linked"`
- **AND** each linked page's chunks are merged independently

#### Scenario: Local mode HTML merging

- GIVEN local mode is active
- WHEN scroll cycles complete
- THEN the HTML is merged client-side using the existing merge-html.ts and HtmlAssembler.ts
- AND the merged HTML is stored locally
