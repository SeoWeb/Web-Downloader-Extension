# Backend Backup Restore Specification

## Purpose

Durability of the five production MySQL databases (auth, archive, library, search, share): nightly consistent dumps, observable backup runs, encrypted off-host copies with retention, and a documented, drill-verified restore procedure.

## Requirements

### Requirement: Nightly database backups
All five production MySQL databases (auth, archive, library, search, share) SHALL be dumped on a nightly schedule using consistent snapshots (`mysqldump --single-transaction`), compressed, and written to a backup location outside the MySQL container. Backup runs SHALL be observable: each run logs its duration and per-database sizes, and the most recent successful backup timestamp SHALL be discoverable without entering the database container.

#### Scenario: Nightly dump covers every database
- **WHEN** the nightly backup job runs
- **THEN** each of the five databases is dumped with `--single-transaction` (consistent point-in-time snapshot)
- **AND** the dumps are compressed and named with database and date

#### Scenario: Backup failure is visible
- **WHEN** the backup job fails for any database (or does not run)
- **THEN** the failure is logged with a non-zero exit
- **AND** the absence of a fresh backup is detectable by the documented check (timestamp/marker), not silent

### Requirement: Off-host copy and retention
Backups SHALL be copied to storage that survives loss of the database host (a second machine or object storage), encrypted in transit and at rest with a key that is not stored on the database host. At least 14 days of daily backups SHALL be retained, with automatic pruning of older copies.

#### Scenario: Host loss does not destroy backups
- **WHEN** the database host becomes permanently unavailable
- **THEN** restorable backups remain available off-host
- **AND** the off-host copies are encrypted and decryptable only with the external key

#### Scenario: Retention prunes old copies
- **WHEN** the backup job completes
- **THEN** off-host copies older than the retention window are pruned automatically

### Requirement: Documented and verified restore procedure
A restore runbook SHALL document the exact steps to restore any database from a backup into a fresh MySQL instance (including decrypt, decompress, and import commands). The procedure SHALL be executed at least once into a scratch database, and the drill's outcome SHALL be recorded in the runbook.

#### Scenario: Restore drill succeeds
- **WHEN** the documented restore procedure is executed against a scratch database
- **THEN** the restored database contains the expected tables and row counts from the backup point
- **AND** the drill (date, backup used, result) is recorded in the runbook

#### Scenario: Restore is role-complete without improvisation
- **WHEN** an operator follows only the runbook
- **THEN** no step requires knowledge that exists only in a person's head (all commands, paths, and key locations are written down)
