## MODIFIED Requirements

### Requirement: Contract Stability
The canonical proto contracts SHALL remain backward-compatible within a running deployment: additive changes (new optional fields on requests or responses) SHALL be permitted and SHALL ship together with regenerated stubs on both provider and consumer sides. Existing field numbers and types SHALL NOT be reused or re-typed. This change relies on additive additions (e.g., `owner_user_id` on the share validation response, `plan` on the token-verification response).

#### Scenario: Additive field addition is compatible
- **WHEN** a response message gains a new optional field and the consumer is older than the provider
- **THEN** the older consumer ignores the unknown field without error
- **AND** the newer consumer reads the field

#### Scenario: Stubs are regenerated in the same change
- **WHEN** a proto file changes (additively)
- **THEN** the generated stubs for all services that reference it are regenerated in the same change
- **AND** no hand-edited generated files exist
