"""Text helpers shared across services.

The search index column is MEDIUMTEXT (16 MB). Slicing a Python ``str`` by
characters (``text[:16 * 1024 * 1024]``) can produce a UTF-8 encoding far past
the byte limit (3 bytes per CJK char) and can split a multi-byte sequence,
which MySQL rejects ("Data too long") — permanently degrading the page to a
preview-only index. Truncation must therefore happen on the encoded bytes.
"""

_DEFAULT_LIMIT_BYTES = 16 * 1024 * 1024 - 4096


def truncate_utf8(text: str, limit_bytes: int = _DEFAULT_LIMIT_BYTES) -> str:
    """Truncate ``text`` to at most ``limit_bytes`` of UTF-8, byte-safely.

    Encodes to UTF-8, slices the byte string, and decodes with errors
    ``"ignore"`` so a cut landing mid-character drops the partial sequence
    instead of producing U+FFFD or raising. The result always round-trips
    through ``str.encode("utf-8")`` within the limit.
    """
    encoded = text.encode("utf-8")
    if len(encoded) <= limit_bytes:
        return text
    return encoded[:limit_bytes].decode("utf-8", "ignore")
