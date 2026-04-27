## ADDED Requirements

### Requirement: Download interrupted state
The sidepanel SHALL display an "interrupted" UI state when a `DOWNLOAD_INTERRUPTED` message is received from the background service worker. The interrupted state SHALL show the interrupted phase, a brief explanation, and a "Restart download" button.

#### Scenario: Interrupted message received during panel open
- **WHEN** the sidepanel receives a `DOWNLOAD_INTERRUPTED` message with `{ phase, tabUrl, timestamp }`
- **THEN** the UI transitions to an interrupted state showing the phase name, an explanation that the download was interrupted because the extension was restarted, and a "Restart download" button

#### Scenario: Interrupted state on panel reopen
- **WHEN** the sidepanel opens and the background reports an interrupted download
- **THEN** the UI immediately shows the interrupted state

#### Scenario: Restart download from interrupted state
- **WHEN** the user clicks "Restart download" in the interrupted state
- **THEN** a new download is initiated for the same tab URL with the previously selected download options
- **AND** the UI transitions to the normal downloading state

## MODIFIED Requirements

### Requirement: Side Panel Activation

The extension SHALL operate through a Chrome side panel that opens when the extension action is clicked.

#### Scenario: Opening the side panel

- GIVEN the user clicks the extension action button
- WHEN the side panel opens
- THEN the current tab's URL and title are displayed
- AND the download filter options are shown
- AND the download button is available

#### Scenario: No active tab

- GIVEN no active tab is available
- WHEN the side panel loads
- THEN an appropriate error message is displayed

#### Scenario: Panel opens with interrupted download

- GIVEN the background service worker has detected an interrupted download checkpoint
- WHEN the side panel opens
- THEN the panel queries the background for interrupted state
- AND displays the interrupted UI if a checkpoint exists
