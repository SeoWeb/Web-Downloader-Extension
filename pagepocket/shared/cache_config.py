"""Cache TTL constants and key helpers."""

# TTLs (seconds)
TTL_SHORT = 60          # 1 min  – list queries with pagination
TTL_MEDIUM = 300        # 5 min  – individual resources
TTL_LONG = 3600         # 1 hour – search results, share validation
TTL_SHARE_LINK = 1800   # 30 min – share link lookups
# harden-pagepocket-platform 2.15(c): a cached entry that would validate a
# token as valid=true must never outlive a concurrent revocation by long —
# valid links are cached only for this bounded window (≪ the old 1800 s),
# while revoked/expired/private links keep TTL_SHARE_LINK for metadata.
TTL_SHARE_VALID = 60
# harden-pagepocket-platform 1.17: view-count dedupe window per
# (token, viewer) — repeated hits inside the window record at most one view.
TTL_VIEW_DEDUPE = 300


# ── Key builders ──────────────────────────────────────────────

def key_collection(coll_id: str) -> str:
    return f"library:collection:{coll_id}"


def key_collections_list(user_id: str, parent_id: str) -> str:
    return f"library:collections:{user_id}:{parent_id or 'root'}"


def key_collection_page_ids(user_id: str, coll_id: str) -> str:
    """Page-id list for one collection (2.12: scoped by user AND collection —
    a collection_id alone would let one user's request be served from another
    user's cached id list)."""
    return f"library:collection_pages:{user_id}:{coll_id}"


def key_page(page_id: str) -> str:
    return f"archive:page:{page_id}"


def key_pages_list(user_id: str, page: int, size: int, sort: str, coll_id: str) -> str:
    return f"archive:pages:{user_id}:{page}:{size}:{sort}:{coll_id or 'all'}"


def key_search(user_id: str, query: str, page: int, size: int, coll_id: str) -> str:
    return f"search:{user_id}:{query}:{page}:{size}:{coll_id or 'all'}"


def key_share_token(token: str) -> str:
    """Lookup cache entry for one share link.

    harden-pagepocket-platform 2.15(a): share-service callers pass the token
    HASH (the DB no longer stores plaintext tokens, and page-wide revocations
    must be able to rebuild this key from the stored hash alone)."""
    return f"share:token:{token}"


def key_share_page(user_id: str, page_id: str) -> str:
    return f"share:page:{user_id}:{page_id}"


def key_share_view(token_hash: str, viewer_hash: str) -> str:
    """View-dedupe counter per (token, viewer) — harden-pagepocket-platform 1.17."""
    return f"share:view:{token_hash}:{viewer_hash}"


# ── Invalidation patterns ─────────────────────────────────────

def pattern_collections(user_id: str) -> str:
    return f"library:collections:{user_id}:*"


def pattern_collection_pages(user_id: str, coll_id: str) -> str:
    return f"library:collection_pages:{user_id}:{coll_id}"


def pattern_pages(user_id: str) -> str:
    return f"archive:pages:{user_id}:*"


def pattern_search(user_id: str) -> str:
    return f"search:{user_id}:*"
