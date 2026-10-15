"""Keep this suite's per-service modules authoritative during test runs.

The five services name their modules identically (``models``, ``servicer``,
``quota``, ``page_processor``). Each suite registers its own copies under a
unique ``sys.modules`` alias when it is first collected (see the test modules)
and this hook re-points the shared names at this suite's aliases before every
test — without ever re-importing a module, which would clash on SQLAlchemy
table definitions. Combined multi-suite pytest runs therefore run each suite
against its own service code.
"""
import os
import sys

_ALIAS_PREFIX = "_ppsvc_" + os.path.basename(
    os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
) + "_"
_SERVICE_MODULES = ("models", "servicer", "quota", "page_processor")


def pytest_runtest_setup(item):
    for _name in _SERVICE_MODULES:
        _mod = sys.modules.get(_ALIAS_PREFIX + _name)
        if _mod is not None:
            sys.modules[_name] = _mod
