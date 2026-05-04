## ADDED Requirements

### Requirement: Download Complete UI Hides on New Download
When the download complete UI is displayed and the user initiates a new download by clicking "Start Download", the system SHALL hide the download complete UI and SHALL display the download progress UI.

#### Scenario: New download hides complete UI
- **GIVEN** a previous download has completed and `action` is `DOWNLOAD_DONE`
- **WHEN** the user clicks "Start Download" to begin a new download
- **THEN** `action` is reset to `null`
- **AND** the `DownloadComplete` component returns `null` (hides)
- **AND** the `DownloadStatus` component renders (shows)
- **AND** the `Actions` stepper component renders (shows)

#### Scenario: New download clears interrupt state
- **GIVEN** a previous download was interrupted and `interruptData` is set
- **WHEN** the user clicks "Start Download" to begin a new download
- **THEN** `interruptData` is reset to `null`
- **AND** the interrupt card in `DownloadStatus` does not render
