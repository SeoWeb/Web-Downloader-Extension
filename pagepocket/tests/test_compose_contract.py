"""Compose-contract render test (harden-pagepocket-platform 4.13).

Renders the dev compose file and the production overlay via
``docker compose ... config`` and asserts the deployment contract that
several hardening tasks depend on:

- share-service is armed in prod: ``ENVIRONMENT=production`` + real
  ``BASE_URL`` (4.8 — its fail-fast used to be dead code and prod short
  links pointed at ``http://localhost:8090``);
- the gateway gets the full env contract (REDIS_URL, ENVIRONMENT,
  CORS_ALLOW_ORIGINS, TRUSTED_PROXIES, MAX_UPLOAD_BYTES, GATEWAY_WORKERS,
  MAX_INGEST_ASSETS);
- NO service publishes a port on anything but 127.0.0.1 (5.11 contract);
- Redis always runs with ``--requirepass`` (5.10);
- per-service DB_URL is present (dev) and references the scoped
  least-privilege user — never root — in the prod overlay (D12/2.16);
- the monolith confinement plumbing exists: archive-/auth-service are
  attached to the confined ``pagepocket-monolith`` network (2.17) and the
  monolith's own compose attaches to it instead of ``pagepocket_default``.

Skips gracefully when docker is unavailable (e.g. unit mode in an
environment without the docker CLI) — the skip reason states what is NOT
being verified. CI's backend job runs on a docker-enabled runner, so the
contract is enforced there for real.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

PAGEPOCKET_DIR = Path(__file__).resolve().parents[1]
SERVER_DIR = PAGEPOCKET_DIR.parent / "server"

BASE_COMPOSE = PAGEPOCKET_DIR / "docker-compose.yml"
PROD_COMPOSE = PAGEPOCKET_DIR / "docker-compose.prod.yml"
IT_COMPOSE = PAGEPOCKET_DIR / "docker-compose.it.yml"
SERVER_COMPOSE = SERVER_DIR / "docker-compose.yml"

if shutil.which("docker") is None:  # unit mode without docker — state it loudly
    pytest.skip(
        "docker CLI not available — cannot render the compose files; "
        "the compose contract (loopback ports, redis requirepass, prod "
        "ENVIRONMENT/BASE_URL arming, scoped DB users, confinement "
        "networks) is NOT verified in this environment",
        allow_module_level=True,
    )

# Minimal scratch .env so renders are hermetic (a developer's real .env
# must not influence the contract) and the prod overlay's :? guards pass.
SCRATCH_ENV = {
    "MYSQL_ROOT_PASSWORD": "ci-root-password",
    "JWT_SECRET": "ci-jwt-secret",
    "REDIS_PASSWORD": "ci-redis-password",
    "BASE_URL": "https://pagepocket.app",
    "DB_PASSWORD_AUTH": "ci-auth-db-password",
    "DB_PASSWORD_ARCHIVE": "ci-archive-db-password",
    "DB_PASSWORD_LIBRARY": "ci-library-db-password",
    "DB_PASSWORD_SEARCH": "ci-search-db-password",
    "DB_PASSWORD_SHARE": "ci-share-db-password",
}

GRPC_SERVICES = {
    "auth-service": "auth_db",
    "archive-service": "archive_db",
    "library-service": "library_db",
    "search-service": "search_db",
    "share-service": "share_db",
}

SCOPE_USERS = {
    "auth-service": "pagepocket_auth",
    "archive-service": "pagepocket_archive",
    "library-service": "pagepocket_library",
    "search-service": "pagepocket_search",
    "share-service": "pagepocket_share",
}


def _render(tmp_path: Path, *compose_files: Path, project: str | None = None) -> dict[str, Any]:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "".join(f"{k}={v}\n" for k, v in sorted(SCRATCH_ENV.items())), encoding="utf-8"
    )
    cmd = ["docker", "compose"]
    if project:
        cmd += ["-p", project]
    cmd += ["--env-file", str(env_file)]
    for f in compose_files:
        cmd += ["-f", str(f)]
    cmd += ["config", "--format", "json"]
    proc = subprocess.run(
        cmd, capture_output=True, text=True, cwd=str(PAGEPOCKET_DIR), timeout=120
    )
    if proc.returncode != 0:
        pytest.fail(
            f"docker compose config failed for {[f.name for f in compose_files]}:\n"
            f"{proc.stderr.strip()[-2000:]}"
        )
    return json.loads(proc.stdout)


def _env(config: dict[str, Any], service: str) -> dict[str, Any]:
    env = config["services"][service].get("environment") or {}
    assert isinstance(env, dict), f"{service}: expected environment mapping"
    return env


def _published_ports(config: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """service name -> list of port entries that publish a HOST port."""
    out: dict[str, list[dict[str, Any]]] = {}
    for name, svc in config["services"].items():
        ports = [
            p
            for p in (svc.get("ports") or [])
            if p.get("published") not in (None, "", [])
        ]
        if ports:
            out[name] = ports
    return out


def test_base_render_contract(tmp_path: Path) -> None:
    cfg = _render(tmp_path, BASE_COMPOSE)

    # every service the stack promises exists
    for svc in (*GRPC_SERVICES, "mysql", "redis", "api-gateway", "archive-maintenance"):
        assert svc in cfg["services"], f"base render is missing {svc}"

    # 5.11: NOTHING may publish on a non-loopback host address
    published = _published_ports(cfg)
    for svc, ports in published.items():
        for p in ports:
            assert p.get("host_ip") == "127.0.0.1", (
                f"{svc} publishes a port on {p.get('host_ip')!r} — the "
                f"loopback-only contract (5.11) forbids non-loopback binds"
            )
    assert "3306" in {str(p["published"]) for p in published["mysql"]}
    assert "8090" in {str(p["published"]) for p in published["api-gateway"]}

    # 5.10: redis requires a password
    assert "--requirepass" in (cfg["services"]["redis"].get("command") or [])

    # D12/2.16: per-service DB_URL present in dev (root fallback allowed)
    # and the mysql container receives the seed passwords for init-users.sh
    for svc, schema in GRPC_SERVICES.items():
        db_url = _env(cfg, svc).get("DB_URL", "")
        assert db_url, f"{svc} has no DB_URL"
        assert schema in db_url, f"{svc} DB_URL does not point at {schema}: {db_url}"
    # D12/2.16: mysql container receives the seed passwords for init-users.sh
    for svc in GRPC_SERVICES:
        key = f"DB_PASSWORD_{svc.split('-')[0].upper()}"  # auth-service -> DB_PASSWORD_AUTH
        assert _env(cfg, "mysql").get(key), f"mysql container lacks the {key} seed for {svc}"

    # 1.4/1.9/D2: gateway env contract (dev half)
    gw = _env(cfg, "api-gateway")
    for key in ("REDIS_URL", "TRUSTED_PROXIES", "GATEWAY_WORKERS", "MAX_INGEST_ASSETS", "MAX_UPLOAD_BYTES"):
        assert gw.get(key), f"gateway is missing {key} in the base render"

    # D12/2.17: confinement network — archive/auth attached, others not
    nets = cfg.get("networks", {})
    assert nets.get("monolith", {}).get("name") == "pagepocket-monolith"
    assert nets.get("default", {}).get("name") == "pagepocket_default"
    for svc in ("auth-service", "archive-service"):
        attached = cfg["services"][svc].get("networks") or {}
        assert "monolith" in attached, f"{svc} is not attached to the confined monolith network"
    for svc in ("search-service", "library-service", "share-service"):
        attached = cfg["services"][svc].get("networks") or {"default": None}
        assert "monolith" not in attached, (
            f"{svc} must NOT be attached to the confined monolith network"
        )

    # share short-link base has a dev default
    assert _env(cfg, "share-service").get("BASE_URL")


def test_prod_overlay_contract(tmp_path: Path) -> None:
    cfg = _render(tmp_path, BASE_COMPOSE, PROD_COMPOSE)

    # 4.8: share-service prod config is ARMED (fail-fast actually live)
    share_env = _env(cfg, "share-service")
    assert share_env.get("ENVIRONMENT") == "production", (
        "share-service ENVIRONMENT=production missing in the prod overlay — "
        "its BASE_URL fail-fast would stay dead code"
    )
    base_url = share_env.get("BASE_URL", "")
    assert base_url and base_url != "http://localhost:8090", (
        "share-service BASE_URL must be a real public host in prod"
    )

    # gateway env contract (prod half)
    gw = _env(cfg, "api-gateway")
    for key in (
        "REDIS_URL",
        "ENVIRONMENT",
        "CORS_ALLOW_ORIGINS",
        "TRUSTED_PROXIES",
        "MAX_UPLOAD_BYTES",
        "GATEWAY_WORKERS",
        "MAX_INGEST_ASSETS",
    ):
        assert gw.get(key), f"gateway is missing {key} in the prod render"
    assert gw.get("ENVIRONMENT") == "production"
    assert "*" not in str(gw.get("CORS_ALLOW_ORIGINS")), "CORS allow-list must never contain *"

    # D12/2.16: scoped least-privilege users — never root — in prod DB_URLs.
    # NB: compose's config output masks the tail of values that embed a
    # required (`:?`) secret, so assert on the user prefix + absence of root
    # rather than the full URL.
    for svc, user in SCOPE_USERS.items():
        db_url = _env(cfg, svc).get("DB_URL", "")
        assert db_url.startswith(f"mysql+pymysql://{user}:"), (
            f"{svc} prod DB_URL does not use the scoped user {user}: {db_url}"
        )
        assert "root:" not in db_url, f"{svc} prod DB_URL still connects as root"

    # Regression (2026-10-16 deploy-day incident): the prod DB_URL lines were
    # committed WITHOUT the `@mysql:3306/<db>` host suffix. Compose happily
    # renders a hostless URL and SQLAlchemy crash-loops on it at boot — the
    # rendered-config assertions above cannot catch it (masking), so assert
    # on the RAW overlay text: every scoped DB_URL carries its host part.
    prod_lines = [ln for ln in PROD_COMPOSE.read_text().splitlines() if "DB_URL:" in ln]
    for svc, user in SCOPE_USERS.items():
        schema = user.removeprefix("pagepocket_")
        line = next((ln for ln in prod_lines if f"pagepocket_{schema}:" in ln), "")
        assert f"@mysql:3306/{schema}_db" in line, (
            f"{svc} prod DB_URL lost its @mysql:3306/{schema}_db host part — "
            "SQLAlchemy would crash-loop on a hostless URL: " + line.strip()
        )

    # 5.11: loopback-only. Only the gateway publishes anything in prod.
    published = _published_ports(cfg)
    assert set(published) == {"api-gateway"}, (
        f"prod overlay must leave only the gateway published, got {sorted(published)}"
    )
    for p in published["api-gateway"]:
        assert p.get("host_ip") == "127.0.0.1"
        assert str(p["published"]) == "8090"

    # 5.10: redis requirepass survived the overlay
    assert "--requirepass" in (cfg["services"]["redis"].get("command") or [])


def test_integration_project_is_isolated(tmp_path: Path) -> None:
    """4.6: the -p pagepocket-it project must own its network + volume names."""
    cfg = _render(tmp_path, BASE_COMPOSE, IT_COMPOSE, project="pagepocket-it")
    nets = cfg.get("networks", {})
    assert nets.get("default", {}).get("name") == "pagepocket-it_default", (
        "integration stack must not share the dev/prod pagepocket_default bridge"
    )
    assert not nets.get("default", {}).get("external", False)
    assert nets.get("monolith", {}).get("name") == "pagepocket-it-monolith"
    vols = cfg.get("volumes", {})
    assert vols.get("mysql_data", {}).get("name") == "pagepocket-it_mysql_data", (
        "integration stack must own a project-prefixed mysql volume so a "
        "`down -v` teardown can never wipe prod pagepocket_mysql_data"
    )


@pytest.mark.skipif(
    not SERVER_COMPOSE.exists(), reason="server/docker-compose.yml not present"
)
def test_monolith_compose_is_confined(tmp_path: Path) -> None:
    """2.17: the monolith attaches to the confined network, not pagepocket_default."""
    cfg = _render(tmp_path, SERVER_COMPOSE, project="server-contract-probe")
    app = cfg["services"]["app"]
    attached = set((app.get("networks") or {}).keys())
    assert "pagepocket-monolith" in attached, (
        "monolith app must attach to pagepocket-monolith (confinement)"
    )
    assert "pagepocket_default" not in attached, (
        "monolith app must NOT sit on pagepocket_default — it would reach "
        "search/library/share again"
    )
    assert "default" in attached, "monolith still needs its own db network"
    ext = cfg.get("networks", {}).get("pagepocket-monolith", {})
    assert ext.get("external") is True, "pagepocket-monolith must be external for server/"
