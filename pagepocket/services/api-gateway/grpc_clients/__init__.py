"""gRPC client manager - lazily opens and memoises channels."""

import os
import grpc

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "shared", "proto_generated"))

import auth_pb2_grpc
import archive_pb2_grpc
import library_pb2_grpc
import search_pb2_grpc
import share_pb2_grpc

_channels: dict[str, grpc.Channel] = {}
_stubs: dict[str, object] = {}
_creds: grpc.ChannelCredentials | None = None


def _get_credentials() -> grpc.ChannelCredentials | None:
    global _creds
    if _creds is not None:
        return _creds
    if os.environ.get("MTLS_ENABLED", "false").lower() != "true":
        return None
    from grpc_mtls import secure_channel_credentials
    _creds = secure_channel_credentials()
    return _creds


def _get_channel(addr: str) -> grpc.Channel:
    if addr not in _channels:
        creds = _get_credentials()
        if creds is not None:
            _channels[addr] = grpc.secure_channel(addr, creds)
        else:
            _channels[addr] = grpc.insecure_channel(addr)
    return _channels[addr]


def auth_stub():
    addr = os.environ["AUTH_SERVICE_ADDR"]
    if "auth" not in _stubs:
        _stubs["auth"] = auth_pb2_grpc.AuthServiceStub(_get_channel(addr))
    return _stubs["auth"]


def archive_stub():
    addr = os.environ["ARCHIVE_SERVICE_ADDR"]
    if "archive" not in _stubs:
        _stubs["archive"] = archive_pb2_grpc.ArchiveServiceStub(_get_channel(addr))
    return _stubs["archive"]


def library_stub():
    addr = os.environ["LIBRARY_SERVICE_ADDR"]
    if "library" not in _stubs:
        _stubs["library"] = library_pb2_grpc.LibraryServiceStub(_get_channel(addr))
    return _stubs["library"]


def search_stub():
    addr = os.environ["SEARCH_SERVICE_ADDR"]
    if "search" not in _stubs:
        _stubs["search"] = search_pb2_grpc.SearchServiceStub(_get_channel(addr))
    return _stubs["search"]


def share_stub():
    addr = os.environ["SHARE_SERVICE_ADDR"]
    if "share" not in _stubs:
        _stubs["share"] = share_pb2_grpc.ShareServiceStub(_get_channel(addr))
    return _stubs["share"]
