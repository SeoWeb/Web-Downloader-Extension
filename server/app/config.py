from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Server configuration loaded from environment variables or .env file."""

    # Server
    server_host: str = "0.0.0.0"
    server_port: int = 8000

    # MySQL
    mysql_connection_string: str = "mysql+aiomysql://root:password@localhost:3306/website_downloader"

    # Storage
    storage_root: str = "./storage"

    # Session limits
    max_session_size_mb: int = 1000
    max_html_chunk_size_pct: int = 25  # percentage of max_session_size_mb
    default_retention_days: int = 7
    max_retention_days: int = 30
    min_retention_days: int = 1
    stale_session_timeout_minutes: int = 30
    # Session-creation quota per API key (api-abuse-hardening D5): the
    # concurrency cap counts this client's sessions in scraping/uploading/
    # assembling status; the rolling cap bounds creations per trailing 24h.
    # Both are plan-independent in v1 — pagepocket_plan is null for the
    # (default) unbound population, so gating on it would exempt exactly
    # the anonymous abuser.
    max_active_sessions_per_client: int = 20
    max_sessions_per_client_per_day: int = 200

    # CORS
    cors_allowed_origins: list[str] = []
    # Regex pattern for chrome-extension:// origins (always enabled)
    cors_extension_origin_regex: str = r"chrome-extension://.*"

    # Request filtering
    filtered_paths: list[str] = [
        "/owa/",
        "/wp-admin/",
        "/.env",
        "/phpmyadmin/",
        "/admin/",
        "/xmlrpc.php",
    ]

    # Resource guards
    disk_cleanup_threshold_pct: int = 80
    docker_mem_limit: str = "1g"

    # Cleanup
    cleanup_interval_hours: int = 1
    orphaned_api_key_age_days: int = 30

    # API
    api_version: str = "v1"

    # Cloud archive (PagePocket)
    archive_service_addr: str = ""
    archive_ca_cert: str = ""
    archive_client_key: str = ""
    archive_client_cert: str = ""
    # Asset-count cap for cloud push — parity with the gateway's REST ingest
    # MAX_INGEST_ASSETS default (equal defaults carry the parity; the two
    # caps live in different processes with different config systems).
    cloud_max_assets: int = 200

    # PagePocket auth service (cloud identity binding, cloud/link)
    # Sane default matches the compose service name on the internal network.
    auth_service_addr: str = "auth-service:50051"
    auth_ca_cert: str = ""
    auth_client_key: str = ""
    auth_client_cert: str = ""

    # Resource guards — gzip decompression ceiling per uploaded resource
    # (hard cap, independent of the per-session budget).
    max_resource_inflate_mb: int = 50

    # Registration throttling (7.8)
    # Max distinct registration attempts per extension instance id per day
    # and per client IP per day (burst == limit, refill spread over 24h).
    registration_per_instance_daily_limit: int = 10
    # Upper bound for the Retry-After hint emitted on a registration 429
    # (D5): the raw refill estimate for the per-instance limiter is
    # hours-scale, which is useless operationally — the client caps its
    # wait on this hint instead (D11 caps it further at 60s client-side).
    registration_retry_after_max_seconds: int = 300
    # Honor X-Forwarded-For for client-IP resolution ONLY when the monolith
    # sits behind a trusted reverse proxy (default: use the peer address).
    trust_proxy: bool = False

    # Upload body caps (D7): unbounded request bodies against the 2 GB
    # oom_kill_disable single-worker container are a one-request OOM, and
    # millions of tiny rows bloat MySQL and slow every aggregate read.
    # Content-text append cap per upload, in MB.
    max_content_text_mb: int = 5
    # Filename-map upload caps: serialized JSON byte size and entry count.
    max_filename_map_bytes: int = 2_000_000
    max_filename_map_entries: int = 20000
    # Per-session resource-row count cap — generous above
    # ``cloud_max_assets`` (which stays cloud-push-only).
    max_resources_per_session: int = 10000

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
    }

    @property
    def max_html_chunk_size_mb(self) -> int:
        """Maximum HTML chunk size in MB (25% of max session size)."""
        return max(1, self.max_session_size_mb * self.max_html_chunk_size_pct // 100)


settings = Settings()
