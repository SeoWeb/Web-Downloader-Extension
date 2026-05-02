## Context

The server runs as a Docker container serving a browser extension. It currently has:
- An in-memory token bucket rate limiter (`app/api/rate_limiter.py`) with no bot/malicious-request filtering
- No Docker memory limits — the container can consume all host RAM
- Time-based cleanup (`app/services/cleanup.py`) that runs hourly but ignores disk pressure
- A SQLAlchemy async connection pool (`pool_size=10, max_overflow=20`) with no health visibility
- A health endpoint that checks disk space but only alerts passively (< 100MB)

Logs show external bot probing (`/owa/auth/x.js`, etc.) consuming log noise, and user-reported errors correlate with resource pressure rather than application bugs.

## Goals / Non-Goals

**Goals:**
- Short-circuit known malicious/bot request patterns before they reach application logic
- Prevent container OOM kills by enforcing Docker memory limits
- Trigger proactive cleanup when disk usage approaches capacity
- Add basic security response headers
- Surface connection pool health for diagnostics

**Non-Goals:**
- Full WAF or intrusion detection system
- Per-client resource quotas or tenant isolation beyond what exists
- Automatic horizontal scaling
- Circuit breakers for database operations
- Checkpoint/restart for long-running assemblies

## Decisions

### 1. Bot request filtering via ASGI middleware

**Decision**: Add a lightweight ASGI middleware that matches incoming request paths against a configurable list of known bot-scan patterns (e.g. `/owa/`, `/wp-admin/`, `/.env`, `/phpmyadmin/`). Matching requests get an immediate 404 with no further processing.

**Alternatives considered**:
- *Reverse proxy (Nginx)*: Better for production but adds deployment complexity. The middleware is a fallback when no proxy is present.
- *IP blocking*: Bot IPs rotate constantly; path-based filtering is more reliable.
- *User-agent filtering*: Easily spoofed; path matching is deterministic.

**Rationale**: Minimal overhead, no external dependency, covers the majority of automated scan noise seen in logs. Configurable via `config.py` so patterns can be updated without code changes.

### 2. Docker memory limits with OOM-kill disable

**Decision**: Add `mem_limit: 1g` and `oom_kill_disable: true` to the app service in `docker-compose.yml`. Set `mem_swappiness: 0` to prevent swap usage masking memory issues.

**Alternatives considered**:
- *No limit*: Current state — one assembly can consume all host memory.
- *Lower limit (512MB)*: Too tight for 500MB session size plus Python overhead.
- *External monitoring only*: Reactive; doesn't prevent the crash.

**Rationale**: 1GB provides headroom for normal operation (500MB session + Python + DB driver) while capping worst-case memory usage. `oom_kill_disable` lets the container log memory errors instead of being silently killed, making diagnosis possible.

### 3. Disk-space-aware cleanup trigger

**Decision**: Extend the cleanup service to check disk usage before and after its normal sweep. When usage exceeds a configurable threshold (default 80%), it triggers an aggressive cleanup pass that removes the oldest expired sessions first, then progressively removes sessions approaching expiry.

**Alternatives considered**:
- *Separate disk monitor process*: More complex, requires additional container/process.
- *Reject uploads when disk is low*: Pushes the problem to the user; better to clean up first.
- *Fixed storage quota*: Inflexible for varying deployment sizes.

**Rationale**: Piggybacks on existing cleanup infrastructure. The threshold is configurable so operators can tune it to their storage capacity. Aggressive cleanup only fires under pressure, avoiding premature data loss.

### 4. Security response headers middleware

**Decision**: Add a small middleware that strips the `Server` header and adds `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` to all responses.

**Rationale**: Standard hardening, zero performance impact, no configuration needed.

### 5. Connection pool health logging

**Decision**: Add a periodic log line (every 5 minutes via the cleanup scheduler) that reports pool status: `pool_size`, `checked_out`, `overflow`, `checkedout`. Log at WARNING level if `checked_out >= pool_size + max_overflow * 0.8`.

**Rationale**: Non-intrusive diagnostic. Doesn't change pool behavior but surfaces exhaustion risk in logs for investigation.

## Risks / Trade-offs

- **[Bot filter false positives]** → Use conservative pattern list (only well-known exploit paths, not broad regex). Patterns are configurable so operators can remove false matches.
- **[Memory limit too low for concurrent large assemblies]** → 1GB is generous for single sessions; concurrent assemblies may need the limit raised. Operators can tune `mem_limit` in docker-compose.yml.
- **[Aggressive cleanup deletes sessions still being downloaded]** → Only remove sessions past their expiry or that are already in a terminal state. The threshold-based cleanup starts with the oldest expired sessions first.
- **[Pool logging noise]** → Only log at 5-minute intervals and only at WARNING when approaching saturation.
