## ADDED Requirements

### Requirement: Each micro-service has a README.md
Each of the 6 micro-service directories (`api-gateway`, `auth-service`, `archive-service`, `library-service`, `search-service`, `share-service`) SHALL contain a `README.md` file at the service root.

#### Scenario: All services documented
- **WHEN** a developer navigates to any service directory under `pagepocket/services/`
- **THEN** a `README.md` file exists in that directory

### Requirement: README contains an overview section
Each README SHALL include an overview section that summarizes the service's purpose, its port number, and its role in the PagePocket architecture.

#### Scenario: Developer reads service overview
- **WHEN** a developer opens a service's README.md
- **THEN** the first section describes what the service does and which port it runs on

### Requirement: README documents all API endpoints or gRPC methods
Each README SHALL include an API section listing all exposed endpoints (for api-gateway) or gRPC methods (for other services) with brief descriptions of their request parameters and responses.

#### Scenario: Developer looks up available API methods
- **WHEN** a developer consults the API section of a service README
- **THEN** all endpoints/methods are listed with their HTTP paths or gRPC names, parameters, and return values

### Requirement: README documents configuration and environment variables
Each README SHALL include a configuration section listing all environment variables the service reads, with name, description, whether it is required, and default value.

#### Scenario: Developer configures a service locally
- **WHEN** a developer wants to run a service locally
- **THEN** the configuration section lists all required and optional environment variables with descriptions

### Requirement: README documents dependencies
Each README SHALL include a dependencies section listing external packages, other PagePocket services it communicates with, and shared utilities it uses.

#### Scenario: Developer checks service dependencies
- **WHEN** a developer reviews the dependencies section
- **THEN** it lists gRPC service dependencies, shared utility usage, and key external packages

### Requirement: README includes local development instructions
Each README SHALL include a local development section explaining how to install dependencies and run the service standalone.

#### Scenario: Developer starts a service locally
- **WHEN** a developer follows the local development section
- **THEN** they can install requirements and start the service on its designated port

### Requirement: README follows consistent structure
All 6 READMEs SHALL follow the same section order: Overview, API, Configuration, Dependencies, Local Development, Service Communication.

#### Scenario: Consistent navigation across services
- **WHEN** a developer switches between service READMEs
- **THEN** the sections appear in the same order and format
