"""Session-URL validation: scheme allowlist + IP-literal blocklist (D4).

Session creation stores the target URL verbatim — it is echoed in API
responses and baked into archive metadata — so the URL is judged at the
write path, before anything is persisted.

v1 scope (D4, "literal-only"): the URL's *textual form* is judged — scheme
plus host-as-IP-literal — and hostnames are **never resolved via DNS**.
The server performs no outbound fetches of session URLs, so resolving
hostnames would buy no protection (rebinding defeats resolve-then-connect
by construction) while adding blocking DNS I/O to the request path. If the
server ever fetches session URLs, resolution-time validation becomes
mandatory in the fetching component — that is the right enforcement point,
not session-create.

Rejected hosts: IPv4 loopback/private/link-local/unspecified/CGNAT ranges
(127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0.0.0.0/8, 100.64.0.0/10),
IPv6 loopback/unique-local/link-local/unspecified (::1, fc00::/7,
fe80::/10, ::), and IPv4-mapped IPv6 literals (::ffff:0:0/96), which are
evaluated against the IPv4 rules. Alternative literal encodings that
browsers normalize — bracketed IPv6 and pure-integer/hex hosts
(``2130706433`` / ``0x7f000001`` → ``127.0.0.1``) — are resolved to their
address before the host is judged.
"""

import ipaddress
from dataclasses import dataclass
from urllib.parse import urlsplit

# Scheme allowlist (D4): everything else — file:, ftp:, data:, blob:,
# javascript:, unknown schemes — is rejected at session creation.
ALLOWED_SCHEMES = frozenset({"http", "https"})

# Rejection reasons carried in the 400 url_not_allowed body.
REASON_SCHEME_NOT_ALLOWED = "scheme_not_allowed"
REASON_PRIVATE_ADDRESS = "private_address_not_allowed"
REASON_INVALID_URL = "invalid_url"

_REASON_MESSAGES = {
    REASON_SCHEME_NOT_ALLOWED: "Only http and https URLs are allowed",
    REASON_PRIVATE_ADDRESS: (
        "Private, loopback, and link-local target addresses are not allowed"
    ),
    REASON_INVALID_URL: "The URL is not parsable or has no host",
}

# Blocked IPv4 literals (D4): loopback, RFC1918 private, link-local
# (incl. the cloud-metadata endpoint), the unspecified "this host" range,
# and the CGNAT range.
_BLOCKED_IPV4_NETWORKS = (
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),
)

# Blocked IPv6 literals: loopback, unique-local (fc00::/7 covers fd00::/8),
# link-local, and the unspecified address.
_BLOCKED_IPV6_NETWORKS = (
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("::/128"),
)


@dataclass(frozen=True)
class UrlValidationVerdict:
    """Structured outcome of session-URL validation (D4).

    ``allowed`` is True with a None ``reason`` for accepted URLs; every
    rejection carries a machine-readable ``reason`` (``scheme_not_allowed``
    | ``private_address_not_allowed`` | ``invalid_url``) and a
    human-readable ``message`` for the error body.
    """

    allowed: bool
    reason: str | None = None
    message: str = ""

    @classmethod
    def ok(cls) -> "UrlValidationVerdict":
        return cls(allowed=True)

    @classmethod
    def reject(cls, reason: str) -> "UrlValidationVerdict":
        return cls(
            allowed=False,
            reason=reason,
            message=_REASON_MESSAGES[reason],
        )


def _resolve_ip_literal(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """Resolve a hostname to an IP literal, or None if it is not one.

    ``urlsplit().hostname`` already lowercases and strips IPv6 brackets;
    ``strip("[]")`` keeps that true for raw-host callers too. The
    pure-integer / 0x-hex fallback covers URL forms browsers normalize to
    a 32-bit IPv4 address (``2130706433`` / ``0x7f000001`` → 127.0.0.1).
    """
    candidate = host.strip().strip("[]").lower()
    if not candidate:
        return None
    try:
        return ipaddress.ip_address(candidate)
    except ValueError:
        pass

    if candidate.isdigit():
        value = int(candidate, 10)
    elif candidate.startswith("0x") and len(candidate) > 2:
        try:
            value = int(candidate, 16)
        except ValueError:
            return None
    else:
        return None
    # Larger than 32 bits: not an IPv4 encoding we can judge — treat as a
    # name and let the literal-only rule apply.
    if value > 0xFFFFFFFF:
        return None
    return ipaddress.IPv4Address(value)


def _is_blocked_address(
    ip: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> bool:
    """Judge a resolved literal against the D4 blocklist."""
    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped
        if mapped is not None:
            # ::ffff:0:0/96-mapped literals are evaluated against the v4
            # rules (D4).
            ip = mapped
        else:
            return any(ip in net for net in _BLOCKED_IPV6_NETWORKS)
    return any(ip in net for net in _BLOCKED_IPV4_NETWORKS)


def validate_session_url(url: str) -> UrlValidationVerdict:
    """Validate a session target URL (D4). Literal-only: NO DNS resolution.

    Order matters for the reason codes: the scheme is judged first (so
    ``file:///etc/passwd`` is ``scheme_not_allowed``, not ``invalid_url``),
    then the host requirement, then the IP-literal blocklist.
    """
    if not url or not url.strip():
        return UrlValidationVerdict.reject(REASON_INVALID_URL)

    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return UrlValidationVerdict.reject(REASON_INVALID_URL)

    scheme = (parts.scheme or "").lower()
    if scheme not in ALLOWED_SCHEMES:
        return UrlValidationVerdict.reject(REASON_SCHEME_NOT_ALLOWED)

    # A bare (unbracketed) IPv6 authority is not valid URL syntax, so
    # urlsplit cannot expose it as a hostname — "http://::1/" and
    # "http://fc00::1/" yield a mangled/empty hostname. The spec requires
    # bare forms to be judged too: when the raw authority (userinfo
    # stripped) holds multiple unbracketed colons, judge it as an IP
    # literal directly. Host:port authorities (a single colon) never take
    # this path and keep the hostname logic below.
    netloc = parts.netloc.rpartition("@")[2]
    bare_ipv6 = "[" not in netloc and netloc.count(":") >= 2

    host = parts.hostname
    literal_source = netloc if bare_ipv6 else host
    if not host and not bare_ipv6:
        return UrlValidationVerdict.reject(REASON_INVALID_URL)

    ip = _resolve_ip_literal(literal_source)
    if ip is not None and _is_blocked_address(ip):
        return UrlValidationVerdict.reject(REASON_PRIVATE_ADDRESS)

    if not host:
        return UrlValidationVerdict.reject(REASON_INVALID_URL)

    return UrlValidationVerdict.ok()
