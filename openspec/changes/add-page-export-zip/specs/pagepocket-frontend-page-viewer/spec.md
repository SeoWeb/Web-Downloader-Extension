## ADDED Requirements

### Requirement: Download Action

The page viewer SHALL offer downloading the archived page as a ZIP.

#### Scenario: Download button

- **WHEN** a user views a saved page in the viewer
- **THEN** the toolbar MUST include a Download button (alongside Share/Delete) that navigates to `/api/pp/archive/pages/{pageId}/zip`, triggering a browser file download
- **AND** the button MUST expose the shortcut `d` consistent with the existing hotkey set

#### Scenario: Honest labeling

- **WHEN** the Download control is rendered or hovered
- **THEN** it MUST state that the download is a static snapshot and that scripts are not included
