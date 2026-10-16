# R2 Orphan Reconciliation Specification

## Purpose

Keeping R2 object storage consistent with the archive database: best-effort ingest-time cleanup when an ingest fails mid-upload, and a periodic sweep that deletes orphaned page prefixes older than a grace period.

## Requirements

### Requirement: Ingest-time cleanup on failed ingests
When a page ingest fails after some R2 objects were already uploaded (quota rejection mid-upload, DB failure, processing error), the archive service SHALL best-effort delete every R2 object it uploaded for that attempt (prefix `{user_id}/{page_id}/`), so a failed ingest leaves no storage behind and does not consume the user's byte quota.

#### Scenario: Failure after partial asset upload cleans up
- **WHEN** an ingest uploads 30 of 80 assets and then fails (e.g., database insert error)
- **THEN** the service attempts deletion of all objects under the attempt's prefix
- **AND** no `pages` row or quota increment remains for the failed attempt

#### Scenario: Cleanup failure is logged, not fatal
- **WHEN** the best-effort deletion itself fails (transient R2 error)
- **THEN** the failure is logged with the orphaned prefix
- **AND** the original ingest error is still returned to the caller
- **AND** the prefix is eligible for the periodic sweep (below)

### Requirement: Periodic orphan sweep
A scheduled reconciliation job SHALL compare R2 page prefixes (`{user_id}/{page_id}/` and thumbnails `{user_id}/{page_id}.webp`) against the `archive_db.pages` table and delete objects whose `page_id` has no corresponding row, excluding objects younger than a grace period (to avoid racing in-flight ingests). The job SHALL log a summary of scanned and deleted objects.

#### Scenario: Orphaned prefix is swept
- **WHEN** the sweep finds `{user_id}/{page_id}/` objects with no `pages` row and older than the grace period
- **THEN** the objects are deleted
- **AND** the deletion count appears in the job summary log

#### Scenario: Live ingests are never swept
- **WHEN** an ingest is in flight (objects newer than the grace period, no row yet)
- **THEN** the sweep leaves those objects in place

#### Scenario: Quota counters stay consistent
- **WHEN** the sweep deletes orphaned objects
- **THEN** user quota counters are unchanged (orphans were never counted; counted bytes belong to existing rows)
