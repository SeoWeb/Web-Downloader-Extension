#!/usr/bin/env python3
"""Archive maintenance scheduler (harden-backend-security-and-ops 5.9).

Runs as a compose sidecar (service `archive-maintenance`, see
pagepocket/docker-compose.yml + docker-compose.prod.yml) and calls the two
internal archive-service maintenance RPCs on a schedule, so neither depends
on host cron access (the spike found no usable crontab automation path on
the production host):

  - RetryPendingIndexing(limit=RETRY_LIMIT)      every RETRY_INTERVAL_SECONDS
        (default 300 s / 5 min, limit 100) — retries pages whose search
        indexing failed at ingest (wave-1 task 3.8 made these durable).
  - SweepOrphanR2Objects(grace_period_seconds, max_prefixes)
        every SWEEP_INTERVAL_SECONDS (default 86400 s / daily) with a
        7-day grace period — deletes R2 objects with no `pages` row older
        than the grace period (pairs with wave-1 task 2.9 best-effort
        cleanup; the sweep is the reconciliation net).

Every RPC failure is logged and absorbed — the loop never exits on a bad
RPC (docker's restart policy covers real crashes). gRPC channels are
re-dialed after connection errors.

mTLS: when MTLS_ENABLED=true the channel uses CA_CERT / CLIENT_KEY /
CLIENT_CERT (in prod: the api-gateway client identity — see
scripts/prod/README.md, "Archive maintenance sidecar").
"""

import logging
import os
import sys
import time

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("archive-maintenance")

# The image (archive-service Dockerfile) bakes PYTHONPATH for /app/shared and
# /app/shared/proto_generated; add belt-and-braces for local runs.
for _p in ("/app/shared", "/app/shared/proto_generated"):
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.insert(0, _p)

import grpc  # noqa: E402

import archive_pb2  # noqa: E402
import archive_pb2_grpc  # noqa: E402

ADDR = os.environ.get("ARCHIVE_SERVICE_ADDR", "archive-service:50052")
MTLS = os.environ.get("MTLS_ENABLED", "false").lower() == "true"
RETRY_INTERVAL = int(os.environ.get("RETRY_INTERVAL_SECONDS", "300"))
RETRY_LIMIT = int(os.environ.get("RETRY_LIMIT", "100"))
SWEEP_INTERVAL = int(os.environ.get("SWEEP_INTERVAL_SECONDS", "86400"))
SWEEP_GRACE_SECONDS = int(os.environ.get("SWEEP_GRACE_SECONDS", str(7 * 24 * 3600)))
SWEEP_MAX_PREFIXES = int(os.environ.get("SWEEP_MAX_PREFIXES", "0"))

# RPC deadlines: the retry pass touches up to RETRY_LIMIT rows plus one
# search call each; the sweep may list and delete many R2 objects. Both get
# generous, bounded budgets — a hung archive service must not wedge the loop.
RETRY_TIMEOUT = max(RETRY_INTERVAL - 30, 60)
SWEEP_TIMEOUT = 3600


def _credentials():
    """Load mTLS channel credentials (grpc_mtls comes from /app/shared)."""
    from grpc_mtls import secure_channel_credentials

    return secure_channel_credentials()


def _connect():
    if MTLS:
        return grpc.secure_channel(ADDR, _credentials())
    return grpc.insecure_channel(ADDR)


def retry_pending_indexing(stub):
    try:
        resp = stub.RetryPendingIndexing(
            archive_pb2.RetryPendingIndexingRequest(limit=RETRY_LIMIT),
            timeout=RETRY_TIMEOUT,
        )
        log.info(
            "RetryPendingIndexing: retried=%d succeeded=%d",
            resp.retried,
            resp.succeeded,
        )
    except grpc.RpcError as exc:
        log.error("RetryPendingIndexing failed: %s: %s", exc.code(), exc.details())
        return False
    return True


def sweep_orphan_r2_objects(stub):
    try:
        resp = stub.SweepOrphanR2Objects(
            archive_pb2.SweepOrphanR2ObjectsRequest(
                grace_period_seconds=SWEEP_GRACE_SECONDS,
                max_prefixes=SWEEP_MAX_PREFIXES,
            ),
            timeout=SWEEP_TIMEOUT,
        )
        log.info(
            "SweepOrphanR2Objects: scanned_prefixes=%d deleted_prefixes=%d "
            "deleted_objects=%d errors=%d",
            resp.scanned_prefixes,
            resp.deleted_prefixes,
            resp.deleted_objects,
            len(resp.errors),
        )
        for err in resp.errors:
            log.warning("SweepOrphanR2Objects error detail: %s", err)
    except grpc.RpcError as exc:
        log.error("SweepOrphanR2Objects failed: %s: %s", exc.code(), exc.details())
        return False
    return True


def main():
    log.info(
        "archive-maintenance starting: addr=%s mtls=%s retry_interval=%ss "
        "retry_limit=%d sweep_interval=%ss sweep_grace=%ss",
        ADDR, MTLS, RETRY_INTERVAL, RETRY_LIMIT, SWEEP_INTERVAL, SWEEP_GRACE_SECONDS,
    )
    channel = _connect()
    stub = archive_pb2_grpc.ArchiveServiceStub(channel)
    next_retry = time.monotonic() + RETRY_INTERVAL
    next_sweep = time.monotonic() + SWEEP_INTERVAL

    while True:
        now = time.monotonic()
        if now >= next_retry:
            if not retry_pending_indexing(stub):
                # Re-dial: the channel may be in a bad state after a failure.
                channel.close()
                channel = _connect()
                stub = archive_pb2_grpc.ArchiveServiceStub(channel)
            next_retry = time.monotonic() + RETRY_INTERVAL
        if now >= next_sweep:
            if not sweep_orphan_r2_objects(stub):
                channel.close()
                channel = _connect()
                stub = archive_pb2_grpc.ArchiveServiceStub(channel)
            next_sweep = time.monotonic() + SWEEP_INTERVAL
        time.sleep(min(max(next_retry, next_sweep) - time.monotonic(), 30))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
