## ADDED Requirements

### Requirement: Subpage navigation sidebar

When the page detail lists more than one page document, the viewer SHALL render a burger-menu button in the header that opens a sidebar listing the subpages (each entry showing its title and host/path). Selecting a subpage SHALL swap the main content pane in place — fetching the subpage's stored document (`pages/<path>` content via the same sandboxed, no-store fetch pattern as the existing content routes) — without a full route change. The active subpage SHALL be highlighted in the sidebar, the selected state SHALL be reflected in the URL (`?page=` param) and survive back/forward navigation, and the public/share viewer SHALL get parity where the same conventions apply. Pages with a single page document SHALL NOT show the burger button.

#### Scenario: Multi-document page shows burger and sidebar

- **WHEN** the page detail response lists more than one page document
- **THEN** the viewer renders a burger-menu button that opens a sidebar
- **AND** the sidebar lists every subpage with its title and host/path

#### Scenario: Selecting a subpage swaps the main pane

- **WHEN** the user selects a subpage in the sidebar
- **THEN** the main content pane swaps to that subpage's document by fetching its `pages/<path>` content
- **AND** no full route change occurs (the viewer shell stays mounted)

#### Scenario: URL param updates and survives navigation

- **WHEN** a subpage is selected
- **THEN** the URL is updated with a `?page=` param (alongside the existing `?format=` params) via a non-scrolling replace
- **AND** browser back/forward restores the previously selected subpage like format switching does today

#### Scenario: Single-document page shows no burger

- **WHEN** the page detail lists one page document (or none — a legacy page)
- **THEN** the burger-menu button and sidebar are not rendered and the viewer behaves as today

### Requirement: Retryable viewer load failures

The viewer SHALL distinguish page-detail fetch failures: a true 404 (page absent or not owned) SHALL render the not-found page as today, while transient failures (network errors, gateway errors, 5xx responses) SHALL render a retryable error state with a Retry action instead of `notFound()`, so a failed load is recoverable without leaving the route.

#### Scenario: Transient failure shows a retry state

- **WHEN** the page-detail fetch fails with a transient failure (network error, gateway error, or 5xx)
- **THEN** the viewer renders a retryable error state with a Retry action
- **AND** it does not render the not-found page

#### Scenario: Retry succeeds and renders

- **WHEN** the user clicks Retry after a transient failure and the fetch then succeeds
- **THEN** the viewer renders the page normally

#### Scenario: 404 still renders not-found

- **WHEN** the page-detail fetch returns a true 404 (page absent or not owned)
- **THEN** the viewer renders the not-found page unchanged (no retry state)
