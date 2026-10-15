"""Unit tests for gateway gRPC transport discipline (tasks 4.1, 4.2).

- Channel options must raise the message-size limits to the archive service's
  256 MB (archive-service/main.py).
- Every gateway stub call in the routers owned by this task group must carry an
  explicit `timeout=` kwarg (static AST check — hang-proof deadlines).
"""

import ast
import os
import unittest
from unittest import mock

import grpc_clients
from grpc_clients import CHANNEL_OPTIONS, GRPC_MAX_MESSAGE_LENGTH

_ROUTERS_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "routers"))
_OWNED_ROUTERS = ("auth.py", "library.py", "search.py")

_EXPECTED_LIMIT = 256 * 1024 * 1024


class TestChannelOptions(unittest.TestCase):
    def test_limits_match_archive_service(self):
        self.assertEqual(GRPC_MAX_MESSAGE_LENGTH, _EXPECTED_LIMIT)
        opts = dict(CHANNEL_OPTIONS)
        self.assertEqual(opts["grpc.max_send_message_length"], _EXPECTED_LIMIT)
        self.assertEqual(opts["grpc.max_receive_message_length"], _EXPECTED_LIMIT)

    def test_channel_is_created_with_options(self):
        grpc_clients._channels.clear()
        fake_channel = mock.MagicMock()
        with mock.patch.object(
            grpc_clients.grpc, "insecure_channel", return_value=fake_channel
        ) as factory:
            channel = grpc_clients._get_channel("localhost:19999")
        self.assertIs(channel, fake_channel)
        factory.assert_called_once()
        self.assertEqual(
            dict(factory.call_args.kwargs["options"]),
            {
                "grpc.max_receive_message_length": _EXPECTED_LIMIT,
                "grpc.max_send_message_length": _EXPECTED_LIMIT,
            },
        )
        grpc_clients._channels.clear()


class TestEveryStubCallHasDeadline(unittest.TestCase):
    def _missing_timeouts(self, path):
        with open(path) as fh:
            tree = ast.parse(fh.read())
        missing = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            # Pattern: <x>_stub().<Method>(...)
            is_stub_call = (
                isinstance(func, ast.Attribute)
                and isinstance(func.value, ast.Call)
                and isinstance(func.value.func, ast.Name)
                and func.value.func.id.endswith("_stub")
            )
            if is_stub_call and not any(kw.arg == "timeout" for kw in node.keywords):
                missing.append(f"{os.path.basename(path)}:{node.lineno} {func.attr}")
        return missing

    def test_owned_routers_carry_explicit_timeouts(self):
        problems = []
        for name in _OWNED_ROUTERS:
            problems.extend(self._missing_timeouts(os.path.join(_ROUTERS_DIR, name)))
        self.assertEqual(problems, [], f"gRPC calls missing an explicit timeout=: {problems}")


if __name__ == "__main__":
    unittest.main()
