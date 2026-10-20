## ADDED Requirements

### Requirement: Card Download Action

The dashboard per-page action menu SHALL offer downloading the page as a ZIP.

#### Scenario: Menu entry

- **WHEN** a user opens a page card's action dropdown
- **THEN** the menu MUST include a Download entry that navigates to `/api/pp/archive/pages/{pageId}/zip`
- **AND** the entry MUST be wired through the same handler pattern as the existing Share/Delete actions and close the menu after triggering
