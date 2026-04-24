## MODIFIED Requirements

### Requirement: ZIP Mode URL Conversion

The system SHALL convert all resource URLs in the HTML to relative local paths for ZIP archive packaging, ensuring that linked page filenames are deterministic and match across conversion and assembly in both local and server modes.

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
