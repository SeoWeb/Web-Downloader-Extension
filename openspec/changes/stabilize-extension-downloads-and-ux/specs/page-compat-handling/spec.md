## ADDED Requirements

### Requirement: Script injection failures surface as errors
The `executeScript` wrapper SHALL reject its promise when `chrome.scripting.executeScript` rejects, and SHALL resolve with a failure result when injection returns no usable result. The scraping loop SHALL treat both as a bounded stop condition.

#### Scenario: Restricted page fails fast
- **WHEN** the user starts a download on a `chrome://` page, the PDF viewer, the Chrome Web Store, or a crashed tab
- **THEN** `executeScript` rejects, the scraping loop stops, and the panel shows an error within seconds — no indefinite spinner

#### Scenario: Injection returns nothing usable
- **WHEN** all injection results are falsy
- **THEN** the wrapper resolves with `success: false` and the loop stops with a clear message instead of waiting forever

### Requirement: Unsupported pages are detected before start
The side panel SHALL pre-validate the active tab's URL and, when the page cannot be downloaded (non-http(s), browser-internal pages, Web Store, `file://` without access), SHALL render a friendly unsupported-page state with the download form disabled.

#### Scenario: chrome:// page shows unsupported state
- **WHEN** the active tab is `chrome://settings`
- **THEN** the panel explains this page type cannot be downloaded and the Start control is disabled — no failing download attempt is possible

#### Scenario: Supported page shows the normal form
- **WHEN** the active tab is `https://example.com/article`
- **THEN** the panel shows the connected state and an enabled Start control

#### Scenario: Tab switches update the state
- **WHEN** the user switches the active tab while the panel is open
- **THEN** the panel re-evaluates the new tab's eligibility and updates its state accordingly

### Requirement: HTTP status is checked before capture is reported
The panel SHALL NOT report a successful connection for tabs whose URL cannot be scripted; connection state SHALL derive from the same validation used by the download path.
