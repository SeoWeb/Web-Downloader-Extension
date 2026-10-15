# Download UX Feedback Specification

## Purpose

Defines how the side panel communicates download outcomes: local fallback on server failure, a persistent per-category failure summary on completion, persistent announcement dismissal, explicit cancellation states, accessibility conformance, and distinct failure explanations instead of silent retry loops.

## Requirements

### Requirement: Local fallback on server failure
When server assembly or finalization fails, the completion/error state SHALL offer a translated "Download locally instead" action (in addition to Retry) when a fallback deliverable is obtainable. The action SHALL use the existing localized strings for label and warning.

#### Scenario: Server down offers local fallback
- **WHEN** assembly polling fails and a fallback path exists
- **THEN** the panel shows both Retry and "Download locally instead" with the localized warning text

#### Scenario: No fallback available shows retry only
- **WHEN** no fallback deliverable exists for the failed session
- **THEN** only Retry is offered

### Requirement: Persistent failure summary on completion
The completion screen SHALL display a persistent per-category report (succeeded / failed / skipped counts for images, styles, scripts, documents) aggregated from the download's status messages, so partial success is visible after the fact.

#### Scenario: Clean download shows a green report
- **WHEN** all assets succeed
- **THEN** the completion screen shows the report with zero failures

#### Scenario: Partial download is visible
- **WHEN** 200 images fail but the ZIP completes
- **THEN** the completion screen shows the failure counts prominently instead of only a success hero

### Requirement: Announcement dismissal persists
Dismissing the PagePocket announcement via "Maybe Later" or the close button SHALL persist the dismissal so the modal does not re-open on every panel open.

#### Scenario: Maybe-later sticks
- **WHEN** the user clicks "Maybe Later" and reopens the panel
- **THEN** the announcement modal is not shown again (until a new announcement version, if implemented)

### Requirement: Explicit cancellation states
Stopping a download SHALL present an explicit outcome: the partial-save path SHALL indicate "Saving what we captured…" and mark the completion report as partial; a full cancel SHALL show the localized cancelled state rather than resetting silently.

#### Scenario: Stop during scraping with partial save
- **WHEN** the user presses Stop mid-scrape and partial packaging proceeds
- **THEN** the panel communicates that a partial archive is being saved and the completion report marks it partial

#### Scenario: Full cancel resets with feedback
- **WHEN** the user cancels outright
- **THEN** the panel shows the cancelled state before returning to ready

### Requirement: Accessibility conformance fixes
Interactive UI SHALL have unique element IDs, expanded/collapsed disclosure controls SHALL expose `aria-expanded` and remove collapsed content from tab order, the language listbox SHALL support Arrow/Escape keys, and no user-facing English SHALL be hardcoded in shipped components.

#### Scenario: Duplicate IDs eliminated
- **WHEN** the download form renders
- **THEN** every form control has a unique `id` and associated label

#### Scenario: Collapsed section is not tabbable
- **WHEN** the advanced-config section is collapsed
- **THEN** its controls are not focusable and the toggle reports `aria-expanded="false"`

#### Scenario: Language picker is keyboard operable
- **WHEN** the language listbox is open and the user presses ArrowDown/Escape
- **THEN** focus moves between options / the listbox closes, without requiring a mouse

### Requirement: Server failure is never a silent retry loop
If every retry of session finalization fails, the panel SHALL surface a distinct failure explanation (with server-unavailable wording) rather than looping generic "Download failed" states.
