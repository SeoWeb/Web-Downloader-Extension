"""mTLS credential helpers for gRPC servers and clients."""

import os
import sys

import grpc


def require_certs() -> None:
    """Validate that all required mTLS cert env vars point to readable files."""
    for var in ("CA_CERT", "SERVER_KEY", "SERVER_CERT"):
        path = os.environ.get(var)
        if not path:
            sys.exit(f"MTLS_ENABLED=true but {var} is not set")
        if not os.path.isfile(path):
            sys.exit(f"MTLS_ENABLED=true but {var} file not found: {path}")


def secure_server_credentials() -> grpc.ServerCredentials:
    """Load server mTLS credentials from env var paths."""
    ca_path = os.environ["CA_CERT"]
    key_path = os.environ["SERVER_KEY"]
    cert_path = os.environ["SERVER_CERT"]

    with open(cert_path, "rb") as f:
        cert_chain = f.read()
    with open(key_path, "rb") as f:
        private_key = f.read()
    with open(ca_path, "rb") as f:
        root_certificates = f.read()

    return grpc.ssl_server_credentials(
        [(private_key, cert_chain)],
        root_certificates=root_certificates,
        require_client_auth=True,
    )


def secure_channel_credentials() -> grpc.ChannelCredentials:
    """Load client mTLS credentials from env var paths."""
    ca_path = os.environ["CA_CERT"]
    key_path = os.environ.get("CLIENT_KEY", os.environ.get("SERVER_KEY"))
    cert_path = os.environ.get("CLIENT_CERT", os.environ.get("SERVER_CERT"))

    with open(ca_path, "rb") as f:
        root_certificates = f.read()
    with open(key_path, "rb") as f:
        private_key = f.read()
    with open(cert_path, "rb") as f:
        certificate_chain = f.read()

    return grpc.ssl_channel_credentials(
        root_certificates=root_certificates,
        private_key=private_key,
        certificate_chain=certificate_chain,
    )
