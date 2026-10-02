## ADDED Requirements

### Requirement: Dashboard Route
The frontend SHALL expose `/app` as the authenticated dashboard, listing the user's archived pages.

#### Scenario: Default load
- **WHEN** an authenticated user visits `/app`
- **THEN** the page MUST fetch the first page of `GET /api/v1/archive/pages?page=1&page_size=20&sort_by=archived_at`
- **AND** render the first 20 results as a grid or list of `PageCard` components with title, source URL hostname, archived-at timestamp ("3 days ago"), and a thumbnail placeholder
- **AND** the total count MUST be displayed in the page header

### Requirement: Infinite Scroll
The dashboard SHALL load additional pages on scroll using `react-query`'s `useInfiniteQuery` (or equivalent), with no pagination UI for manual page selection.

#### Scenario: Scroll triggers next page
- **WHEN** the user scrolls within 400px of the bottom sentinel element
- **THEN** the app MUST request the next page via `IntersectionObserver`-triggered fetch
- **AND** append results to the existing list without remounting prior cards

#### Scenario: End of archive
- **WHEN** the cumulative fetched count equals `total`
- **THEN** the sentinel MUST render "You've reached the end" and stop triggering fetches

### Requirement: Sort Controls
The dashboard SHALL allow sorting by `archived_at` (default, descending) or `title` (ascending).

#### Scenario: Change sort
- **WHEN** the user selects "Title (A–Z)" from the sort menu
- **THEN** the URL MUST update to `?sort_by=title`
- **AND** the list MUST refetch from page 1 with the new sort

### Requirement: Per-Page Row Actions
Each `PageCard` SHALL expose quick actions: Open, Share, Move to collection, Delete.

#### Scenario: Open
- **WHEN** the user clicks a card (but not on an action button)
- **THEN** the app MUST navigate to `/app/pages/[pageId]`

#### Scenario: Share
- **WHEN** the user clicks the share icon
- **THEN** the Share dialog MUST open with this `pageId` preselected (see `pagepocket-frontend-sharing`)

#### Scenario: Move to collection
- **WHEN** the user clicks the "Move" icon
- **THEN** a combobox MUST appear listing the user's collections; selecting one MUST call `POST /api/v1/library/collections/{id}/pages` with this `page_id`
- **AND** on success the action MUST show a toast "Moved to <collection name>" with an Undo button that calls the remove endpoint

#### Scenario: Delete
- **WHEN** the user clicks the delete icon and confirms
- **THEN** the card MUST optimistically disappear from the list
- **AND** `DELETE /api/v1/archive/pages/{id}` MUST be called
- **AND** on error the card MUST reappear and a toast MUST surface the error

### Requirement: Empty State
The dashboard SHALL render a dedicated empty state when the user has zero archived pages.

#### Scenario: Zero-archive user
- **WHEN** `total == 0` on first fetch
- **THEN** the page MUST render a centered empty state with: an illustration, "No saved pages yet", a short explainer, and two CTAs — "Install the extension" (links to Chrome Web Store) and "Watch a 60-second demo" (placeholder link)
