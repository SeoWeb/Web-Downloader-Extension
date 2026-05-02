## ADDED Requirements

### Requirement: Database healthcheck allows full initialization
The MySQL healthcheck SHALL include a `start_period` of at least 30 seconds and a `retries` count of at least 10, so that Docker ignores transient failures while MySQL completes user setup, permission grants, and socket creation on cold starts.

#### Scenario: Fresh volume cold start
- **WHEN** MySQL starts for the first time with an empty data volume
- **THEN** Docker SHALL NOT report the db service as unhealthy until at least 30 seconds have elapsed and 10 consecutive healthcheck failures occur

#### Scenario: Warm restart with existing data
- **WHEN** MySQL restarts with an existing data volume
- **THEN** the healthcheck SHALL pass normally within the standard interval, as initialization is fast

### Requirement: Application waits for database port before starting
The app container command SHALL poll the database TCP port (db:3306) in a loop before launching the application server, ensuring MySQL is accepting connections before any migration or query is attempted.

#### Scenario: Database ready immediately
- **WHEN** the app container starts and the database port is already accepting connections
- **THEN** the wait loop SHALL exit immediately and the application SHALL start without delay

#### Scenario: Database not yet ready
- **WHEN** the app container starts and the database port is not accepting connections
- **THEN** the app SHALL retry the port check every 1 second until it succeeds, and SHALL NOT start the application server until the connection succeeds

### Requirement: Restart policy includes a delay
The app service restart policy SHALL include a delay between restart attempts to avoid rapid crash loops that can overwhelm the database during startup.

#### Scenario: Application crashes on startup
- **WHEN** the app process exits with a failure code
- **THEN** Docker SHALL wait at least 5 seconds before restarting the container, and SHALL attempt at most 3 restarts before giving up
