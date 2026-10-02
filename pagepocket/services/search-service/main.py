"""Search service entry point."""

import os
import sys
from concurrent import futures

import grpc

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import search_pb2_grpc
from grpc_mtls import require_certs, secure_server_credentials
from servicer import SearchServicer


def serve():
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    search_pb2_grpc.add_SearchServiceServicer_to_server(SearchServicer(), server)

    mtls = os.environ.get("MTLS_ENABLED", "false").lower() == "true"
    if mtls:
        require_certs()
        server.add_secure_port("[::]:50054", secure_server_credentials())
    else:
        server.add_insecure_port("[::]:50054")

    print(f"Search service starting on :50054 (mTLS={mtls})")
    server.start()
    server.wait_for_termination()


if __name__ == "__main__":
    serve()
