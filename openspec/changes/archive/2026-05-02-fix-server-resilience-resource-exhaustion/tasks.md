## 1. Configuration

- [x] 1.1 Add `filtered_paths` config setting to `app/config.py` with default list of known bot-scan paths (`/owa/`, `/wp-admin/`, `/.env`, `/phpmyadmin/`, `/admin/`, `/xmlrpc.php`)
- [x] 1.2 Add `disk_cleanup_threshold_pct` config setting to `app/config.py` with default value `80`
- [x] 1.3 Add `docker_mem_limit` config setting to `app/config.py` for documentation/coordination (actual limit is in docker-compose.yml)

## 2. Request Filtering Middleware

- [x] 2.1 Create `app/middleware/request_filter.py` with ASGI middleware that matches request paths against `filtered_paths` and returns 404 immediately for matches
- [x] 2.2 Register the request filter middleware in `app/main.py` before CORS and rate limiter middleware
- [x] 2.3 Verify filtered requests do not appear in logs at INFO level (log at DEBUG instead)

## 3. Security Headers Middleware

- [x] 3.1 Create `app/middleware/security_headers.py` with ASGI middleware that strips `Server` header and adds `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`
- [x] 3.2 Register the security headers middleware in `app/main.py`

## 4. Disk-Space-Aware Cleanup

- [x] 4.1 Add disk usage calculation helper to `app/services/cleanup.py` that returns usage percentage of `STORAGE_ROOT` mount point
- [x] 4.2 Add aggressive cleanup method to `app/services/cleanup.py` that removes oldest expired sessions first, then sessions within 10% of expiry, when disk usage exceeds threshold
- [x] 4.3 Modify the cleanup cron job to check disk usage before/after normal cleanup and trigger aggressive cleanup when threshold is exceeded
- [x] 4.4 Add logging of disk usage percentage and bytes freed after every cleanup run

## 5. Connection Pool Monitoring

- [x] 5.1 Add pool status logging function to `app/db/database.py` that reports `pool_size`, `checked_out`, and `overflow` from the engine's pool
- [x] 5.2 Schedule pool status logging every 5 minutes via the existing cleanup scheduler in `app/main.py`, with WARNING level when checked_out exceeds 80% of capacity

## 6. Docker Resource Limits

- [x] 6.1 Add `mem_limit: 1g`, `mem_swappiness: 0`, and `oom_kill_disable: true` to the app service in `docker-compose.yml`
- [x] 6.2 Verify the Docker container starts successfully with memory limits applied
