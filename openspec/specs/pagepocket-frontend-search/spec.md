## ADDED Requirements

### Requirement: Global Search Bar
The authenticated topbar SHALL host a search input that, on submit, navigates to `/app/search?q=<query>`.

#### Scenario: Submit query
- **WHEN** the user types in the topbar search and presses Enter
- **THEN** the app MUST navigate to `/app/search?q=<url-encoded query>`
- **AND** the search input on the results page MUST be prefilled with the same value

#### Scenario: Debounced typeahead (preview)
- **WHEN** the user types 3+ characters in the topbar search without pressing Enter
- **THEN** after 250 ms of inactivity the app MAY fetch the first 5 results as a preview dropdown (`page=1&page_size=5`)
- **AND** selecting a preview result MUST navigate directly to `/app/pages/[pageId]`

### Requirement: Search Results Page
The `/app/search` route SHALL render results from `GET /api/v1/search?q=<q>&page=<n>&page_size=20&collection_id=<id?>`.

#### Scenario: Render results
- **WHEN** results arrive
- **THEN** each result MUST render as a card with: title (linked to `/app/pages/[id]`), source URL hostname, archived-at timestamp, and a `snippet` with matching terms highlighted
- **AND** the snippet highlighting MUST use `<mark>` and MUST be sanitised (HTML escaped except for the `<mark>` wrappers added by the frontend from server-provided plain-text offsets)

#### Scenario: No results
- **WHEN** `total == 0`
- **THEN** an empty state MUST render with "No pages match '<query>'" and a "Clear search" button that navigates to `/app`

#### Scenario: Empty query
- **WHEN** `q` is empty or whitespace-only in the URL
- **THEN** the page MUST render a placeholder "Type a search term" state and MUST NOT call the API

### Requirement: Collection Filter
The search page SHALL support filtering by collection via a `collection_id` query parameter.

#### Scenario: Filter chip
- **WHEN** the user opens search from within a collection context
- **THEN** the page MUST render a removable filter chip showing the collection name
- **AND** the request MUST include `collection_id=<id>`

#### Scenario: Remove filter
- **WHEN** the user clicks the X on the collection chip
- **THEN** the URL MUST drop `collection_id` and results MUST refetch without the filter

### Requirement: Keyboard Navigation
The search page SHALL support arrow-key navigation through results and Enter to open.

#### Scenario: Arrow + Enter
- **WHEN** the user focuses the results list and presses Down/Up
- **THEN** focus MUST cycle through result cards with a visible focus ring (WCAG AA)
- **AND** pressing Enter on a focused result MUST navigate to `/app/pages/[pageId]`

### Requirement: Result Virtualisation Threshold
If a result set exceeds 200 items, the list SHALL virtualise to avoid DOM bloat.

#### Scenario: Large result set
- **WHEN** `total > 200`
- **THEN** the list MUST use a windowed renderer (e.g. `@tanstack/react-virtual`) rendering only visible rows + a small overscan
- **AND** keyboard navigation MUST still work correctly across virtualised rows
