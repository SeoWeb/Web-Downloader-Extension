"""Memoized gRPC channel/stub pool for service-to-service clients.

Mirrors the api-gateway's ``grpc_clients`` pattern: one channel per upstream
address, created lazily and reused for the process lifetime — never a fresh
channel (and TCP+TLS handshake) per call (harden-pagepocket-platform D7/2.10).
Credentials are mTLS-aware via ``shared/grpc_mtls`` when ``MTLS_ENABLED=true``.

Usage (services adopt this identically to the gateway)::

    from grpc_pool import get_stub
    stub = get_stub(addr, search_pb2_grpc.SearchServiceStub)
    stub.IndexPage(req, timeout=30)
"""

import os
import threading

import grpc

_channels: dict[str, grpc.Channel] = {}
_stubs: dict[str, object] = {}
# Reentrant: get_stub holds it while calling get_channel.
_lock = threading.RLock()
_creds: grpc.ChannelCredentials | None = None

# Match the services' server-side max message lengths so large legitimate
# payloads are not rejected client-side at the gRPC default.
GRPC_MAX_MESSAGE_LENGTH = 256 * 1024 * 1024  # 256 MB

CHANNEL_OPTIONS = [
    ("grpc.max_receive_message_length", GRPC_MAX_MESSAGE_LENGTH),
    ("grpc.max_send_message_length", GRPC_MAX_MESSAGE_LENGTH),
]


def _get_credentials() -> grpc.ChannelCredentials | None:
    global _creds
    if _creds is not None:
        return _creds
    if os.environ.get("MTLS_ENABLED", "false").lower() != "true":
        return None
    from grpc_mtls import secure_channel_credentials

    _creds = secure_channel_credentials()
    return _creds


def get_channel(service_address: str, *, secure: bool = True) -> grpc.Channel:
    """Return the memoized channel for ``service_address``, creating it once.

    With ``secure=True`` (default) the channel uses mTLS credentials when
    ``MTLS_ENABLED=true`` and is otherwise plaintext; ``secure=False`` forces
    a plaintext channel regardless of the environment.
    """
    with _lock:
        channel = _channels.get(service_address)
        if channel is None:
            creds = _get_credentials() if secure else None
            if creds is not None:
                channel = grpc.secure_channel(
                    service_address, creds, options=CHANNEL_OPTIONS
                )
            else:
                channel = grpc.insecure_channel(
                    service_address, options=CHANNEL_OPTIONS
                )
            _channels[service_address] = channel
        return channel


def get_stub(service_address: str, stub_factory, *, secure: bool = True):
    """Return a memoized stub for ``service_address`` (built once per factory).

    ``stub_factory`` is a generated ``*_pb2_grpc.*ServiceStub`` class; the
    stub is constructed once over the shared channel and returned on every
    subsequent call for the same (factory, address) pair.
    """
    key = f"{getattr(stub_factory, '__module__', '')}.{getattr(stub_factory, '__qualname__', stub_factory.__name__)}@{service_address}"
    with _lock:
        stub = _stubs.get(key)
        if stub is None:
            stub = stub_factory(get_channel(service_address, secure=secure))
            _stubs[key] = stub
        return stub


def reset_pool() -> None:
    """Drop all memoized channels/stubs (tests and forked workers only)."""
    global _creds
    with _lock:
        _stubs.clear()
        _channels.clear()
        _creds = None
