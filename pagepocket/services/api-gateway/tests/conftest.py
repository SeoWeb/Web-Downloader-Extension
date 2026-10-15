"""Shared path setup for api-gateway unit tests.

Puts the gateway dir, shared/, and the generated stubs on sys.path so unit
tests can import the app modules without the docker stack. The integration
suite (test_gateway_integration.py) self-skips without a live gateway; these
unit tests must always run.
"""

import os
import sys

_GW_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
_SHARED_DIR = os.path.normpath(os.path.join(_GW_DIR, "..", "..", "shared"))

for _path in (_GW_DIR, _SHARED_DIR, os.path.join(_SHARED_DIR, "proto_generated")):
    if _path not in sys.path:
        sys.path.insert(0, _path)

os.environ.setdefault("JWT_SECRET", "test-secret-key")

os.environ.pop("ENVIRONMENT", None)
