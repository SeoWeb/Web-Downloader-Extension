## ADDED Requirements

### Requirement: Per-page progress counter

During linked-page scraping, the panel SHALL render a prominent "Page X of Y" counter on the scraping card, driven by the `status.linkedPageProgress` current/total values. The counter SHALL be first-class card state, not solely a scrolling message-feed subtitle. When no linked-page scraping is in progress, no counter SHALL render.

#### Scenario: Counter increments per page

- **WHEN** each linked page begins processing during scraping
- **THEN** the counter's current value advances to that page's number

#### Scenario: Counter shows totals

- **WHEN** linked-page scraping is active
- **THEN** the scraping card renders the "Page X of Y" counter using the current and total values from `status.linkedPageProgress`

#### Scenario: No scraping renders no counter

- **WHEN** no linked-page scraping is in progress
- **THEN** no per-page counter is rendered

### Requirement: Paused download state

The panel SHALL render an explicit localized Paused state with Resume and Stop controls while a pause is held (worker alive) or a parked pause awaits action (worker died). A paused download SHALL NOT be presented as an interruption or as a completion.

#### Scenario: Pause pressed shows paused state with both controls

- **WHEN** the user presses Pause during linked-page scraping
- **THEN** the panel shows the localized Paused state with both Resume and Stop controls

#### Scenario: Parked pause after reopen shows the same card

- **GIVEN** the service worker died while the pause was held and the panel is reopened
- **WHEN** the paused checkpoint (phase `paused` with queue snapshot) is found
- **THEN** the same Paused card with Resume and Stop controls is rendered

#### Scenario: Resume returns to progress state

- **WHEN** the user clicks Resume on the Paused state
- **THEN** the paused state is replaced by the scraping progress state, including the per-page counter

### Requirement: Honest merge-phase wording for text-only runs

When the session options have `downloadHtml` false, the assembly-phase subtitle for the `merging_html` phase SHALL use wording explaining that the merge prepares the text/markdown conversion, rather than implying an unexpected HTML download. Runs with HTML output enabled SHALL keep the existing wording.

#### Scenario: Text-only run shows the explanatory wording

- **GIVEN** a session whose options have `downloadHtml` false
- **WHEN** assembly enters the `merging_html` phase
- **THEN** the subtitle uses wording explaining that the merge prepares the text/markdown conversion

#### Scenario: HTML run shows existing wording

- **GIVEN** a session whose options have `downloadHtml` true
- **WHEN** assembly enters the `merging_html` phase
- **THEN** the existing merge-phase subtitle wording is shown
