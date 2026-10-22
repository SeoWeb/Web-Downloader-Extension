"""Auth service entry point."""

import os
import sys
from concurrent import futures

import grpc

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

# Fail fast BEFORE importing servicer: a clean configuration error (easier-auth
# D7 — Google credentials required in production) beats a late traceback.
from config import enforce_startup_config, warn_if_google_signin_disabled

enforce_startup_config()

import auth_pb2_grpc
from grpc_mtls import require_certs, secure_server_credentials
from logging_config import configure_logging
from servicer import AuthServicer


def serve():
    configure_logging()
    warn_if_google_signin_disabled()
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    auth_pb2_grpc.add_AuthServiceServicer_to_server(AuthServicer(), server)

    mtls = os.environ.get("MTLS_ENABLED", "false").lower() == "true"
    if mtls:
        require_certs()
        server.add_secure_port("[::]:50051", secure_server_credentials())
    else:
        server.add_insecure_port("[::]:50051")

    print(f"Auth service starting on :50051 (mTLS={mtls})")
    server.start()
    server.wait_for_termination()


if __name__ == "__main__":
    serve()
