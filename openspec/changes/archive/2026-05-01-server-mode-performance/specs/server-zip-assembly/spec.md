## MODIFIED Requirements

### Requirement: Batched Assembly Progress Updates

The server SHALL batch database progress flushes during ZIP assembly, updating progress in-memory for each resource but only flushing to the database every 10 resources or at phase boundaries. This reduces database writes by approximately 90% for typical pages without meaningfully affecting progress granularity.

#### Scenario: Progress flushed in batches during ZIP assembly
- **GIVEN** a session is assembling a ZIP with 200 resources
- **WHEN** the ZIP assembly loop adds resources
- **THEN** progress is updated in-memory for each resource
- **AND** the database is flushed every 10 resources
- **AND** the total number of database flushes during ZIP assembly is approximately 20 (instead of 200)

#### Scenario: Progress always flushed at phase boundaries
- **GIVEN** the assembly pipeline transitions between phases
- **WHEN** a phase completes (e.g., CSS conversion finishes)
- **THEN** progress is flushed to the database immediately regardless of batch counter

#### Scenario: Progress granularity remains useful for polling
- **GIVEN** a client polls assembly status every 2 seconds
- **WHEN** assembly is actively adding resources to the ZIP
- **THEN** the client observes progress updates at approximately 5% granularity (10 resources at a time for a 200-resource page)

### Requirement: Parallel CSS File Conversion

The server SHALL convert CSS file `url()` references in parallel using `asyncio.gather` with a semaphore, instead of sequentially processing each CSS file.

#### Scenario: CSS files converted concurrently
- **GIVEN** a session has 20 CSS resource files to convert
- **WHEN** the assembly pipeline reaches the CSS conversion phase
- **THEN** up to 10 CSS files are converted concurrently
- **AND** each CSS file is read, converted, and written independently

#### Scenario: CSS conversion semaphore prevents resource exhaustion
- **GIVEN** a session has 100 CSS files to convert
- **WHEN** the CSS conversion phase runs
- **THEN** at most 10 files are being converted at the same time
- **AND** the thread pool is not exhausted

### Requirement: Parallel Linked Page HTML Conversion

The server SHALL convert linked page HTML in parallel using `asyncio.gather` with a semaphore, instead of processing each linked page sequentially.

#### Scenario: Linked pages converted concurrently
- **GIVEN** a session has 15 linked pages to convert
- **WHEN** the assembly pipeline reaches the linked page conversion phase
- **THEN** up to 10 linked pages are converted concurrently
- **AND** each page's HTML is independently converted with URL rewriting

#### Scenario: Single linked page processes normally
- **GIVEN** a session has only 1 linked page
- **WHEN** the linked page conversion phase runs
- **THEN** the single page is converted without parallelism overhead
