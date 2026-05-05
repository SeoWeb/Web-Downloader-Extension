"""Library service entry point."""

import os
import sys
from concurrent import futures

import grpc

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import library_pb2_grpc
from servicer import LibraryServicer
from grpc_mtls import require_certs, secure_server_credentials


def serve():
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    library_pb2_grpc.add_LibraryServiceServicer_to_server(LibraryServicer(), server)

    mtls = os.environ.get("MTLS_ENABLED", "false").lower() == "true"
    if mtls:
        require_certs()
        server.add_secure_port("[::]:50053", secure_server_credentials())
    else:
        server.add_insecure_port("[::]:50053")

    print("Library service starting on :50053 (mTLS=%s)" % mtls)
    server.start()
    server.wait_for_termination()


if __name__ == "__main__":
    serve()
