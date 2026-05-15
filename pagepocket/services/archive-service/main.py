"""Archive service entry point."""

import os
import sys
from concurrent import futures

import grpc

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import archive_pb2_grpc
from servicer import ArchiveServicer
from grpc_mtls import require_certs, secure_server_credentials


def serve():
    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=10),
        options=[
            ("grpc.max_receive_message_length", 256 * 1024 * 1024),
            ("grpc.max_send_message_length", 256 * 1024 * 1024),
        ],
    )
    archive_pb2_grpc.add_ArchiveServiceServicer_to_server(ArchiveServicer(), server)

    mtls = os.environ.get("MTLS_ENABLED", "false").lower() == "true"
    if mtls:
        require_certs()
        server.add_secure_port("[::]:50052", secure_server_credentials())
    else:
        server.add_insecure_port("[::]:50052")

    print("Archive service starting on :50052 (mTLS=%s)" % mtls)
    server.start()
    server.wait_for_termination()


if __name__ == "__main__":
    serve()
