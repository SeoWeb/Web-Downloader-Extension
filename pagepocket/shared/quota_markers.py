"""Structured quota/limit error markers shared by gateway and archive-service.

The archive-service stamps a machine-readable prefix into the gRPC status
details of ``RESOURCE_EXHAUSTED`` errors (e.g.
``"exhausted:quota|Monthly page limit reached"``); the API gateway parses the
prefix to pick the HTTP status (quota → 402, size → 413, rate → 429). Both
sides import the literals from this single module so the wire format has one
source of truth.

The legacy English-prose matching in the gateway stays as a fallback for the
monolith / older archive builds, but new producers must use the prefix.
"""

EXHAUSTED_PREFIX = "exhausted:"

KIND_QUOTA = "quota"
KIND_SIZE = "size"
KIND_RATE = "rate"

_KNOWN_KINDS = (KIND_QUOTA, KIND_SIZE, KIND_RATE)

# The kind is the first segment of the remainder: "exhausted:<kind>|<human>".
_KIND_SEPARATOR = "|"


def parse_exhausted_kind(details: str) -> str | None:
    """Return the exhaustion kind encoded in *details*, or None.

    Returns one of ``KIND_QUOTA`` / ``KIND_SIZE`` / ``KIND_RATE`` when
    *details* starts with ``exhausted:`` and carries a known kind (anything
    after the first ``|`` is treated as the human-readable message). Returns
    None when the prefix is absent or the kind is unknown — callers should
    fall back to their legacy matching in that case.
    """
    if not details or not details.startswith(EXHAUSTED_PREFIX):
        return None
    remainder = details[len(EXHAUSTED_PREFIX):]
    kind = remainder.split(_KIND_SEPARATOR, 1)[0].strip()
    if kind in _KNOWN_KINDS:
        return kind
    return None
