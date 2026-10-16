"""Unit tests for gateway gRPC transport discipline (tasks 4.1, 4.2, 6.1).

- Channel options must raise the message-size limits to the archive service's
  256 MB (archive-service/main.py).
- Every gateway stub call in the routers owned by this task group must carry an
  explicit `timeout=` kwarg (static AST check — hang-proof deadlines).
- Every stub call must be dispatched off the event loop (task 6.1 / spec
  "Every stub call is threadpool-dispatched (AST gate)"): it may only appear as
  the function argument of `run_in_threadpool(...)` — or the ingest route's
  dedicated-bounded-pool `run_ingest(...)`. A bare `<x>_stub().Method(...)`
  call inside an `async def` handler freezes the event loop for up to the full
  RPC deadline and fails this suite.
"""

import ast
import os
import unittest
from unittest import mock

import grpc_clients
from grpc_clients import CHANNEL_OPTIONS, GRPC_MAX_MESSAGE_LENGTH

_ROUTERS_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "routers"))
_OWNED_ROUTERS = ("auth.py", "library.py", "search.py", "archive.py", "share.py")

_EXPECTED_LIMIT = 256 * 1024 * 1024

# Dispatch helpers that move the blocking stub call onto a worker thread.
_THREADPOOL_DISPATCHERS = ("run_in_threadpool", "run_ingest")


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


def _walk_with_ancestors(node, ancestors=()):
    """Yield (node, ancestor_tuple) over the whole AST, root first."""
    yield node, ancestors
    for child in ast.iter_child_nodes(node):
        yield from _walk_with_ancestors(child, (*ancestors, node))


def _stub_getter_call(node):
    """The node itself when it is a call to a `<x>_stub` getter, else None."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id.endswith("_stub"):
        return node
    return None


def _stub_method_attr(node):
    """`<x>_stub().Method` attribute node, when node is such an attribute."""
    if isinstance(node, ast.Attribute) and _stub_getter_call(node.value):
        return node
    return None


def _stub_dispatch_problems(tree):
    """Every `<x>_stub` usage must be `<dispatch>(<x>_stub().Method, ...)`."""
    problems = []
    for node, ancestors in _walk_with_ancestors(tree):
        if _stub_getter_call(node) is None:
            continue
        where = getattr(node, "lineno", "?")
        attr = _stub_method_attr(ancestors[-1] if ancestors else None)
        if attr is None:
            problems.append(f"line {where}: bare stub-getter call without a .Method dispatch")
            continue
        consumer = ancestors[-2] if len(ancestors) >= 2 else None
        is_dispatch = (
            isinstance(consumer, ast.Call)
            and isinstance(consumer.func, ast.Name)
            and consumer.func.id in _THREADPOOL_DISPATCHERS
        )
        if not is_dispatch:
            problems.append(
                f"line {where}: `{attr.attr}` sync stub call not wrapped in "
                f"{'/'.join(_THREADPOOL_DISPATCHERS)}"
            )
            continue
        if not consumer.args or attr is not consumer.args[0]:
            problems.append(f"line {where}: `{attr.attr}` is not the dispatched function argument")
    return problems


def _missing_timeouts(tree):
    """Dispatched stub calls must forward an explicit `timeout=` kwarg."""
    missing = []
    for node, ancestors in _walk_with_ancestors(tree):
        if _stub_getter_call(node) is None:
            continue
        attr = _stub_method_attr(ancestors[-1] if ancestors else None)
        consumer = ancestors[-2] if len(ancestors) >= 2 else None
        if attr is None or not isinstance(consumer, ast.Call):
            continue
        if not (isinstance(consumer.func, ast.Name) and consumer.func.id in _THREADPOOL_DISPATCHERS):
            continue
        if not any(kw.arg == "timeout" for kw in consumer.keywords):
            missing.append(f"line {getattr(node, 'lineno', '?')}: {attr.attr}")
    return missing


class TestEveryStubCallIsThreadpoolDispatched(unittest.TestCase):
    """Task 6.1 / spec "Every stub call is threadpool-dispatched (AST gate)"."""

    def test_owned_routers_dispatch_every_stub_call(self):
        problems = []
        for name in _OWNED_ROUTERS:
            with open(os.path.join(_ROUTERS_DIR, name)) as fh:
                problems.extend(
                    f"{name}: {problem}" for problem in _stub_dispatch_problems(ast.parse(fh.read()))
                )
        self.assertEqual(problems, [], f"sync gRPC stub calls not dispatched to a worker thread: {problems}")

    def test_gate_fails_on_bare_stub_call(self):
        """Negative control: the pre-fix pattern must be flagged."""
        source = (
            "async def handler(request):\n"
            "    resp = archive_stub().ListPages(req, timeout=30)\n"
        )
        problems = _stub_dispatch_problems(ast.parse(source))
        self.assertTrue(any("not wrapped" in p for p in problems), f"gate missed the bare call: {problems}")

    def test_gate_accepts_wrapped_stub_call(self):
        source = (
            "async def handler(request):\n"
            "    resp = await run_in_threadpool(archive_stub().ListPages, req, timeout=30)\n"
        )
        self.assertEqual(_stub_dispatch_problems(ast.parse(source)), [])

    def test_gate_fails_on_direct_call_shape(self):
        """`run_in_threadpool(stub().ListPages(req))` still calls inline —
        only the function-reference dispatch shape is acceptable."""
        source = (
            "async def handler(request):\n"
            "    resp = await run_in_threadpool(lambda: archive_stub().ListPages(req, timeout=30))\n"
        )
        problems = _stub_dispatch_problems(ast.parse(source))
        self.assertTrue(problems, "gate must reject lambda/direct-call dispatch shapes")


class TestEveryStubCallHasDeadline(unittest.TestCase):
    """The `timeout=` kwarg lives on the dispatch call that forwards to the
    stub method (`run_in_threadpool(stub.Method, req, timeout=30)`)."""

    def test_owned_routers_carry_explicit_timeouts(self):
        missing = []
        for name in _OWNED_ROUTERS:
            with open(os.path.join(_ROUTERS_DIR, name)) as fh:
                missing.extend(f"{name}: {m}" for m in _missing_timeouts(ast.parse(fh.read())))
        self.assertEqual(missing, [], f"gRPC calls missing an explicit timeout=: {missing}")


if __name__ == "__main__":
    unittest.main()
