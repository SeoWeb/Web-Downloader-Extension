## ADDED Requirements

### Requirement: Stop Support for Main Page Scrolling Phase
The system SHALL allow the user to stop the main page scrolling process, and SHALL NOT start the download phase when the stop is user-initiated.

#### Scenario: User stops main page scrolling before bottom is reached
- **GIVEN** the extension is actively scrolling the main page to capture content
- **AND** the page has not yet reached the bottom
- **WHEN** the user presses the Stop button
- **THEN** the scrolling phase terminates (current in-flight scroll may complete)
- **AND** the download phase does NOT start
- **AND** the UI returns to its idle "Connected" state

#### Scenario: User stops main page scrolling after bottom is reached
- **GIVEN** the extension has reached the bottom of the main page
- **AND** the scrolling settle mechanism is in progress (waiting to confirm bottom)
- **WHEN** the user presses the Stop button
- **THEN** the scrolling phase terminates
- **AND** the download phase does NOT start
- **AND** the UI returns to its idle "Connected" state

#### Scenario: Stop during subsequent download session unaffected
- **GIVEN** a previous download session was stopped by the user via the Stop button
- **AND** the user starts a new download session
- **WHEN** the new session's scrolling phase reaches the bottom naturally
- **THEN** the download phase starts normally
- **AND** the previous stop does not prevent the new download
