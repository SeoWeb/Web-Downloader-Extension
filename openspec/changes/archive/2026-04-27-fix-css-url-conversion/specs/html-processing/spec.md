## MODIFIED Requirements

### Requirement: ZIP Mode URL Conversion

The system SHALL convert all resource URLs in the HTML to relative local paths for ZIP archive packaging, ensuring that linked page filenames are deterministic and match across conversion and assembly in both local and server modes. In server mode, URL conversion is performed by the server using the uploaded filename map; in local mode, it is performed by the extension.

#### Scenario: Image src conversion

- GIVEN an HTML document containing `<img src="https://example.com/images/photo.jpg">`
- WHEN ZIP mode conversion is applied
- THEN the src attribute is changed to `./images/photo.jpg`
- AND the image filename map is consulted first for correct extensions from Content-Type headers

#### Scenario: Image with extension-less URL

- GIVEN an HTML document containing `<img src="https://example.com/xid-31821076_1">`
- WHEN ZIP mode conversion is applied
- THEN the system generates a safe filename for the image
- AND the src is changed to `./images/<generated-filename>`

#### Scenario: CSS link href conversion

- GIVEN an HTML document containing `<link rel="stylesheet" href="https://example.com/css/style.css">`
- WHEN ZIP mode conversion is applied
- THEN the href is changed to `./styles/style.css`

#### Scenario: JavaScript src conversion

- GIVEN an HTML document containing `<script src="https://example.com/js/app.js">`
- WHEN ZIP mode conversion is applied
- THEN the src is changed to `./scripts/app.js`

#### Scenario: Anchor href conversion for same-origin links

- GIVEN an HTML document containing `<a href="https://example.com/about">`
- WHEN ZIP mode conversion is applied
- AND the link origin matches the page origin
- THEN the href is changed to `./pages/about.html`
- AND the filename `about.html` is deterministic based on the URL's last path segment
- AND the same filename is used to store the linked page in the ZIP's `pages/` directory in both local and server modes

#### Scenario: Anchor href for linked page with path collision

- GIVEN two same-origin links with URLs that share the same last path segment (e.g., `/about/team` and `/contact/team`)
- WHEN ZIP mode conversion is applied
- THEN the first link's href uses `./pages/team.html`
- AND the second link's href uses `./pages/team-<short_hash>.html` to avoid collision
- AND the same collision-avoidance is applied when storing the linked page files

#### Scenario: External links preserved

- GIVEN an HTML document containing `<a href="https://other-site.com/page">`
- WHEN ZIP mode conversion is applied
- AND the link origin differs from the page origin
- THEN the href is left unchanged

#### Scenario: Background image URL conversion in inline styles

- GIVEN an HTML element with `style="background-image: url('https://example.com/bg.jpg')"`
- WHEN ZIP mode conversion is applied
- THEN the background-image URL is changed to `./images/bg.jpg`

#### Scenario: Background image URL conversion in style tags

- GIVEN a `<style>` tag containing `background-image: url('https://example.com/bg.jpg')`
- WHEN ZIP mode conversion is applied
- THEN the background-image URL within the style tag is changed to `./images/bg.jpg`

#### Scenario: CSS url() conversion in custom properties and other CSS properties

- GIVEN an HTML element with `style="--image-url: url('https://example.com/photo.jpg')"`
- WHEN ZIP mode conversion is applied
- THEN the URL inside `url()` is changed to `./images/photo.jpg`

#### Scenario: CSS url() conversion in shorthand background

- GIVEN an HTML element with `style="background: url('https://example.com/bg.jpg') no-repeat"`
- WHEN ZIP mode conversion is applied
- THEN the URL inside `url()` is changed to `./images/bg.jpg`

#### Scenario: Object element conversion

- GIVEN an HTML document containing `<object data="https://example.com/file.swf">`
- WHEN ZIP mode conversion is applied
- THEN the data attribute is converted to a relative local path

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
