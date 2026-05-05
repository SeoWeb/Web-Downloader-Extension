"""Library service unit tests — nesting, ownership, cascade delete, idempotent add."""

import importlib.util
import os
import sys
import unittest

_shared = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "shared"))

_spec = importlib.util.spec_from_file_location("db", os.path.join(_shared, "db.py"))
_mod = importlib.util.module_from_spec(_spec)
sys.modules["db"] = _mod
_spec.loader.exec_module(_mod)

sys.path.insert(0, _shared)
sys.path.insert(0, os.path.join(_shared, "proto_generated"))
sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), "..")))

import grpc
import library_pb2
from db import Base, db_session, get_engine
from models import Collection, PageCollection
import servicer as _servicer_mod


class _FakeRpcContext:
    def __init__(self):
        self.code = None
        self.details = None

    def set_code(self, code):
        self.code = code

    def set_details(self, details):
        self.details = details


USER_A = "user-a-001"
USER_B = "user-b-002"


def _init_db():
    from sqlalchemy import event

    engine = get_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)
    return engine


class TestLibraryServicer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = _init_db()
        cls._engine_patcher = unittest.mock.patch.object(
            _servicer_mod, "get_engine", return_value=cls.engine
        )
        cls._engine_patcher.start()

        orig_db_session = _servicer_mod.db_session

        def _bound_session(engine_arg=None):
            return orig_db_session(engine_arg or cls.engine)

        cls._session_patcher = unittest.mock.patch.object(
            _servicer_mod, "db_session", _bound_session
        )
        cls._session_patcher.start()

    @classmethod
    def tearDownClass(cls):
        cls._engine_patcher.stop()
        cls._session_patcher.stop()

    def setUp(self):
        with db_session(self.engine) as s:
            s.query(PageCollection).delete()
            s.query(Collection).delete()
        self.svc = _servicer_mod.LibraryServicer()

    # -- helpers --

    def _create(self, user_id=USER_A, name="Test", parent_id="", **kw):
        ctx = _FakeRpcContext()
        req = library_pb2.CreateCollectionRequest(
            user_id=user_id, name=name, parent_id=parent_id, **kw
        )
        return self.svc.CreateCollection(req, ctx), ctx

    def _get(self, collection_id, user_id=USER_A):
        ctx = _FakeRpcContext()
        req = library_pb2.GetCollectionRequest(collection_id=collection_id, user_id=user_id)
        return self.svc.GetCollection(req, ctx), ctx

    def _list(self, user_id=USER_A, parent_id=""):
        ctx = _FakeRpcContext()
        req = library_pb2.ListCollectionsRequest(user_id=user_id, parent_id=parent_id)
        return self.svc.ListCollections(req, ctx), ctx

    def _delete(self, collection_id, user_id=USER_A):
        ctx = _FakeRpcContext()
        req = library_pb2.DeleteCollectionRequest(collection_id=collection_id, user_id=user_id)
        return self.svc.DeleteCollection(req, ctx), ctx

    def _add_page(self, page_id, collection_id, user_id=USER_A):
        ctx = _FakeRpcContext()
        req = library_pb2.PageCollectionRequest(
            user_id=user_id, page_id=page_id, collection_id=collection_id
        )
        return self.svc.AddPageToCollection(req, ctx), ctx

    def _remove_page(self, page_id, collection_id, user_id=USER_A):
        ctx = _FakeRpcContext()
        req = library_pb2.PageCollectionRequest(
            user_id=user_id, page_id=page_id, collection_id=collection_id
        )
        return self.svc.RemovePageFromCollection(req, ctx), ctx

    # -- CreateCollection --

    def test_create_success(self):
        resp, ctx = self._create(name="Recipes")
        self.assertIsNone(ctx.code)
        self.assertTrue(resp.id)
        self.assertEqual(resp.name, "Recipes")
        self.assertEqual(resp.user_id, USER_A)
        self.assertEqual(resp.page_count, 0)

    def test_create_empty_name(self):
        _, ctx = self._create(name="  ")
        self.assertEqual(ctx.code, grpc.StatusCode.INVALID_ARGUMENT)

    def test_create_default_color(self):
        resp, _ = self._create()
        self.assertEqual(resp.color, "#6B7280")

    def test_create_custom_color(self):
        resp, _ = self._create(color="#FF0000")
        self.assertEqual(resp.color, "#FF0000")

    # -- Nesting --

    def test_create_child_collection(self):
        parent, _ = self._create(name="Parent")
        child, ctx = self._create(name="Child", parent_id=parent.id)
        self.assertIsNone(ctx.code)
        self.assertEqual(child.parent_id, parent.id)

    def test_list_root_collections_only(self):
        parent, _ = self._create(name="Parent")
        self._create(name="Child", parent_id=parent.id)
        self._create(name="Root2")

        resp, _ = self._list()
        names = [c.name for c in resp.collections]
        self.assertIn("Parent", names)
        self.assertIn("Root2", names)
        self.assertNotIn("Child", names)

    def test_list_child_collections(self):
        parent, _ = self._create(name="Parent")
        self._create(name="Child1", parent_id=parent.id)
        self._create(name="Child2", parent_id=parent.id)

        resp, _ = self._list(parent_id=parent.id)
        names = [c.name for c in resp.collections]
        self.assertEqual(sorted(names), ["Child1", "Child2"])

    def test_invalid_parent_id(self):
        _, ctx = self._create(name="Orphan", parent_id="nonexistent-id")
        self.assertEqual(ctx.code, grpc.StatusCode.INVALID_ARGUMENT)

    def test_parent_owned_by_different_user(self):
        parent, _ = self._create(name="Parent", user_id=USER_A)
        _, ctx = self._create(name="Child", user_id=USER_B, parent_id=parent.id)
        self.assertEqual(ctx.code, grpc.StatusCode.INVALID_ARGUMENT)

    # -- Ownership --

    def test_get_own_collection(self):
        coll, _ = self._create(name="Mine")
        resp, ctx = self._get(coll.id)
        self.assertIsNone(ctx.code)
        self.assertEqual(resp.name, "Mine")

    def test_get_others_collection_returns_not_found(self):
        coll, _ = self._create(name="Secret", user_id=USER_A)
        _, ctx = self._get(coll.id, user_id=USER_B)
        self.assertEqual(ctx.code, grpc.StatusCode.NOT_FOUND)

    def test_delete_others_collection_returns_not_found(self):
        coll, _ = self._create(name="Secret", user_id=USER_A)
        _, ctx = self._delete(coll.id, user_id=USER_B)
        self.assertEqual(ctx.code, grpc.StatusCode.NOT_FOUND)

    def test_update_others_collection_returns_not_found(self):
        coll, _ = self._create(name="Secret", user_id=USER_A)
        ctx = _FakeRpcContext()
        req = library_pb2.UpdateCollectionRequest(
            collection_id=coll.id, user_id=USER_B, name="Hacked"
        )
        _, ctx = self.svc.UpdateCollection(req, ctx), ctx
        self.assertEqual(ctx.code, grpc.StatusCode.NOT_FOUND)

    def test_list_only_own_collections(self):
        self._create(name="A1", user_id=USER_A)
        self._create(name="B1", user_id=USER_B)
        resp, _ = self._list(user_id=USER_A)
        self.assertEqual(len(resp.collections), 1)
        self.assertEqual(resp.collections[0].name, "A1")

    # -- Cascade on delete --

    def test_delete_cascades_page_associations(self):
        coll, _ = self._create(name="WithPages")
        self._add_page(page_id="page-1", collection_id=coll.id)
        self._add_page(page_id="page-2", collection_id=coll.id)

        with db_session(self.engine) as s:
            self.assertEqual(s.query(PageCollection).count(), 2)

        self._delete(coll.id)

        with db_session(self.engine) as s:
            self.assertEqual(s.query(PageCollection).count(), 0)

    def test_delete_parent_does_not_delete_children(self):
        parent, _ = self._create(name="Parent")
        child, _ = self._create(name="Child", parent_id=parent.id)

        self._delete(parent.id)

        resp, ctx = self._get(child.id)
        # Child still exists (parent_id SET NULL)
        self.assertIsNone(ctx.code)
        self.assertEqual(resp.parent_id, "")

    # -- AddPageToCollection / RemovePageFromCollection --

    def test_add_page_to_collection(self):
        coll, _ = self._create(name="Coll")
        resp, ctx = self._add_page(page_id="page-1", collection_id=coll.id)
        self.assertIsNone(ctx.code)
        self.assertTrue(resp.success)

        coll_resp, _ = self._get(coll.id)
        self.assertEqual(coll_resp.page_count, 1)

    def test_add_page_idempotent(self):
        coll, _ = self._create(name="Coll")
        resp1, ctx1 = self._add_page(page_id="page-1", collection_id=coll.id)
        resp2, ctx2 = self._add_page(page_id="page-1", collection_id=coll.id)

        self.assertIsNone(ctx1.code)
        self.assertIsNone(ctx2.code)
        self.assertTrue(resp1.success)
        self.assertTrue(resp2.success)

        coll_resp, _ = self._get(coll.id)
        self.assertEqual(coll_resp.page_count, 1)

        with db_session(self.engine) as s:
            self.assertEqual(s.query(PageCollection).count(), 1)

    def test_add_page_to_others_collection_denied(self):
        coll, _ = self._create(name="Mine", user_id=USER_A)
        _, ctx = self._add_page(page_id="page-1", collection_id=coll.id, user_id=USER_B)
        self.assertEqual(ctx.code, grpc.StatusCode.PERMISSION_DENIED)

    def test_remove_page_from_collection(self):
        coll, _ = self._create(name="Coll")
        self._add_page(page_id="page-1", collection_id=coll.id)

        resp, ctx = self._remove_page(page_id="page-1", collection_id=coll.id)
        self.assertIsNone(ctx.code)
        self.assertTrue(resp.success)

        coll_resp, _ = self._get(coll.id)
        self.assertEqual(coll_resp.page_count, 0)

    def test_remove_page_from_others_collection_denied(self):
        coll, _ = self._create(name="Mine", user_id=USER_A)
        self._add_page(page_id="page-1", collection_id=coll.id)

        _, ctx = self._remove_page(page_id="page-1", collection_id=coll.id, user_id=USER_B)
        self.assertEqual(ctx.code, grpc.StatusCode.PERMISSION_DENIED)

    # -- UpdateCollection --

    def test_update_name(self):
        coll, _ = self._create(name="Old")
        ctx = _FakeRpcContext()
        req = library_pb2.UpdateCollectionRequest(
            collection_id=coll.id, user_id=USER_A, name="New"
        )
        resp, ctx = self.svc.UpdateCollection(req, ctx), ctx
        self.assertIsNone(ctx.code)
        self.assertEqual(resp.name, "New")

    def test_update_color(self):
        coll, _ = self._create()
        ctx = _FakeRpcContext()
        req = library_pb2.UpdateCollectionRequest(
            collection_id=coll.id, user_id=USER_A, color="#00FF00"
        )
        resp, ctx = self.svc.UpdateCollection(req, ctx), ctx
        self.assertEqual(resp.color, "#00FF00")


if __name__ == "__main__":
    unittest.main()
