## ADDED Requirements

### Requirement: Session URL scheme allowlist

The session-create endpoint SHALL accept only `http` and `https` URLs as the session target. Any other scheme — including `file:`, `ftp:`, `data:`, `blob:`, and unknown schemes — SHALL be rejected with 400 error `url_not_allowed` and reason `scheme_not_allowed`. A URL without a parsable host SHALL be rejected with 400 error `url_not_allowed` and reason `invalid_url`. The response body SHALL follow the repository's structured error style (`error`, `message`, `api_version`).

#### Scenario: file URL is rejected

- **WHEN** a session is created with `url: "file:///etc/passwd"`
- **THEN** the server responds 400 with error `url_not_allowed` and reason `scheme_not_allowed`
- **AND** no session row is created and no session storage directory is created

#### Scenario: Non-http schemes are rejected

- **WHEN** a session is created with a `data:`, `ftp:`, or unknown-scheme URL
- **THEN** the server responds 400 with error `url_not_allowed` and reason `scheme_not_allowed`

#### Scenario: http and https URLs are accepted

- **WHEN** a session is created with an `http://` or `https://` URL that passes the address checks
- **THEN** the session is created as normal (201)

#### Scenario: Unparsable URL is rejected

- **WHEN** a session is created with a URL that has no parsable host (e.g., `http:///path`)
- **THEN** the server responds 400 with error `url_not_allowed` and reason `invalid_url`

### Requirement: Private and link-local IP-literal targets are rejected

The session-create endpoint SHALL reject URLs whose host is an IP literal within a private, loopback, link-local, unique-local, or otherwise non-public range: IPv4 `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `0.0.0.0/8`, `100.64.0.0/10`; IPv6 `::1/128`, `fc00::/7`, `fe80::/10`, and the unspecified address `::`. IPv4-mapped IPv6 literals (`::ffff:0:0/96`) SHALL be evaluated against the IPv4 rules. Alternative literal encodings that normalize to a blocked address — bracketed IPv6, and integer/hex-form hosts — SHALL be resolved before the host is judged. Rejections SHALL use 400 error `url_not_allowed` with reason `private_address_not_allowed`.

#### Scenario: Loopback literal is rejected

- **WHEN** a session is created with `url: "http://127.0.0.1/"` (or any other `127.0.0.0/8` address)
- **THEN** the server responds 400 with error `url_not_allowed` and reason `private_address_not_allowed`

#### Scenario: RFC1918 and link-local literals are rejected

- **WHEN** a session is created targeting `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (e.g., a cloud metadata endpoint), or `100.64.0.0/10` literals
- **THEN** the server responds 400 with error `url_not_allowed` and reason `private_address_not_allowed`

#### Scenario: IPv6 loopback, unique-local, and link-local literals are rejected

- **WHEN** a session is created targeting `::1`, an `fc00::/7` address, or an `fe80::/10` address (bracketed or bare)
- **THEN** the server responds 400 with error `url_not_allowed` and reason `private_address_not_allowed`

#### Scenario: IPv4-mapped IPv6 and alternate encodings do not bypass the check

- **WHEN** a session is created targeting `::ffff:127.0.0.1`, or a host written in integer or hex form that normalizes to a blocked address (e.g., `2130706433` → `127.0.0.1`)
- **THEN** the server responds 400 with error `url_not_allowed` and reason `private_address_not_allowed`

#### Scenario: Public IP literals are accepted

- **WHEN** a session is created with an `http(s)://` URL whose host is a public IP literal (e.g., `93.184.216.34`)
- **THEN** the session is created as normal (201)

### Requirement: Validation judges IP literals only in v1

Session-URL validation SHALL evaluate the URL's textual form only — scheme plus host-as-literal — and SHALL NOT resolve hostnames via DNS. A hostname that is not an IP literal SHALL be accepted if it is not itself a blocked literal, even if it resolves to a private address. This is an accepted, documented v1 limitation: the server performs no outbound fetches of session URLs, so hostname resolution buys no protection today while adding blocking I/O to the request path. If the server ever fetches session URLs, resolution-time validation SHALL be enforced at the fetching component.

#### Scenario: Hostname form is not resolved

- **WHEN** a session is created with an `http(s)://` URL whose host is a name (not an IP literal)
- **THEN** validation judges the name as written and does not perform a DNS lookup
- **AND** the session is created when the name is not a blocked literal

#### Scenario: Rejections precede all persistence

- **WHEN** a session-create request fails URL validation for any reason
- **THEN** no session row is inserted and no session storage directory is created
- **AND** the rejection precedes quota accounting and any other write
