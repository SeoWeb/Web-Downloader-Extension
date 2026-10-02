## MODIFIED Requirements

### Requirement: Linked Page Queue Management

The system SHALL maintain a queue of linked pages to scrape, with configurable limits and internal-page priority.

#### Scenario: Adding a same-origin link to queue

- GIVEN a URL that shares the same hostname as the parent page
- AND the queue has not reached the maximum page limit
- WHEN the URL is added to the queue
- THEN the URL is enqueued with status "queued"

#### Scenario: Rejecting external links when not enabled

- GIVEN the includeExternal option is false
- AND a URL with a different hostname than the parent page
- WHEN the URL is added to the queue
- THEN the URL is rejected and not enqueued

#### Scenario: External links queued after internal links

- GIVEN the includeExternal option is true
- AND a URL with a different hostname than the parent page
- WHEN the URL is added to the queue
- THEN the URL is enqueued in the external sub-queue
- AND the external link is processed only after all internal links are completed

#### Scenario: Queue size limit with internal priority

- GIVEN the queue has reached the maximum page limit
- WHEN a new URL is added to the queue
- THEN the URL is rejected
- AND if the URL is internal while external links occupy queue slots, the operation MAY still reject if capacity is full (internal links added earlier in DOM order fill first; late-discovered internal links compete with existing entries on equal footing)

#### Scenario: External links fill remaining capacity

- GIVEN the includeExternal option is true
- AND internal links occupy fewer than maxPages queue slots
- WHEN an external link is added to the queue
- THEN the external link is enqueued in the external sub-queue
- AND the combined internal + external count does not exceed maxPages

#### Scenario: External link rejected when capacity is full

- GIVEN the includeExternal option is true
- AND the combined internal + external queue count has reached maxPages
- WHEN an external link is added to the queue
- THEN the external link is rejected

#### Scenario: Duplicate URL rejection

- GIVEN a URL is already present in the queue
- WHEN the same URL is added again
- THEN the duplicate is rejected

#### Scenario: Non-HTML resource rejection

- GIVEN a URL ending with a known non-HTML extension (e.g., .pdf, .jpg, .zip, .mp4)
- WHEN the URL is added to the queue
- THEN the URL is rejected

## ADDED Requirements

### Requirement: Internal-first progress reporting

The system SHALL report the current scraping phase (internal or external) in progress messages.

#### Scenario: Internal phase progress

- GIVEN the scraper is processing internal pages
- WHEN a progress message is sent
- THEN the message includes a phase indicator of "internal"

#### Scenario: External phase progress

- GIVEN the scraper has completed all internal pages and is processing external pages
- WHEN a progress message is sent
- THEN the message includes a phase indicator of "external"
