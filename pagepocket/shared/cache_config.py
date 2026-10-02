"""Cache TTL constants and key helpers."""

# TTLs (seconds)
TTL_SHORT = 60          # 1 min  – list queries with pagination
TTL_MEDIUM = 300        # 5 min  – individual resources
TTL_LONG = 3600         # 1 hour – search results, share validation
TTL_SHARE_LINK = 1800   # 30 min – share link lookups


# ── Key builders ──────────────────────────────────────────────

def key_collection(coll_id: str) -> str:
    return f"library:collection:{coll_id}"


def key_collections_list(user_id: str, parent_id: str) -> str:
    return f"library:collections:{user_id}:{parent_id or 'root'}"


def key_collection_page_ids(coll_id: str) -> str:
    return f"library:collection_pages:{coll_id}"


def key_page(page_id: str) -> str:
    return f"archive:page:{page_id}"


def key_pages_list(user_id: str, page: int, size: int, sort: str, coll_id: str) -> str:
    return f"archive:pages:{user_id}:{page}:{size}:{sort}:{coll_id or 'all'}"


def key_search(user_id: str, query: str, page: int, size: int, coll_id: str) -> str:
    return f"search:{user_id}:{query}:{page}:{size}:{coll_id or 'all'}"


def key_share_token(token: str) -> str:
    return f"share:token:{token}"


def key_share_page(user_id: str, page_id: str) -> str:
    return f"share:page:{user_id}:{page_id}"


# ── Invalidation patterns ─────────────────────────────────────

def pattern_collections(user_id: str) -> str:
    return f"library:collections:{user_id}:*"


def pattern_collection_pages(coll_id: str) -> str:
    return f"library:collection_pages:{coll_id}"


def pattern_pages(user_id: str) -> str:
    return f"archive:pages:{user_id}:*"


def pattern_search(user_id: str) -> str:
    return f"search:{user_id}:*"
