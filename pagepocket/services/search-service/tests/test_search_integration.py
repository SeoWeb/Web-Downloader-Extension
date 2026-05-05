"""Search service integration test — requires a MySQL 8.0 container with ngram FULLTEXT.

Set SEARCH_TEST_DB_URL to the MySQL connection string. Defaults to the
docker-compose dev instance. Skips automatically if MySQL is unreachable.

Usage:
    SEARCH_TEST_DB_URL="mysql+pymysql://root:pagepocket@127.0.0.1:3306/search_db" \
        python3 -m pytest tests/test_search_integration.py -v
"""

import importlib.util
import os
import sys
import uuid
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
import search_pb2
from db import Base, db_session, get_engine
from models import PageIndex
import servicer as _servicer_mod

DB_URL = os.environ.get(
    "SEARCH_TEST_DB_URL",
    "mysql+pymysql://root:pagepocket@127.0.0.1:3306/search_db",
)

_mysql_available = False
try:
    from sqlalchemy import text as sa_text
    _eng = get_engine(DB_URL)
    with _eng.connect() as c:
        c.execute(sa_text("SELECT 1"))
    _mysql_available = True
except Exception:
    pass


@unittest.skipUnless(_mysql_available, "MySQL not available at SEARCH_TEST_DB_URL")
class TestSearchIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = get_engine(DB_URL)
        Base.metadata.create_all(cls.engine)

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
        self.svc = _servicer_mod.SearchServicer()
        self._user_id = str(uuid.uuid4())
        self._indexed_pages = []

    def tearDown(self):
        with db_session(self.engine) as s:
            for page_id in self._indexed_pages:
                s.query(PageIndex).filter_by(page_id=page_id).delete()

    def _index(self, page_id=None, title="", body_text="", user_id=None):
        pid = page_id or str(uuid.uuid4())
        uid = user_id or self._user_id
        ctx = _FakeRpcContext()
        req = search_pb2.IndexPageRequest(
            page_id=pid, user_id=uid, url=f"https://example.com/{pid}",
            title=title, body_text=body_text,
        )
        resp = self.svc.IndexPage(req, ctx)
        self._indexed_pages.append(pid)
        return resp, ctx, pid

    def _search(self, query, user_id=None):
        ctx = _FakeRpcContext()
        req = search_pb2.SearchRequest(
            query=query, user_id=user_id or self._user_id,
        )
        return self.svc.Search(req, ctx), ctx

    # -- Tests --

    def test_cjk_short_token_found(self):
        """ngram parser should find single CJK characters used as short tokens."""
        _, _, pid = self._index(
            title="日本語テスト",
            body_text="これは日本語のテストドキュメントです。東京は日本の首都です。",
        )
        resp, ctx = self._search("東京")
        self.assertEqual(ctx.code, None)
        self.assertGreater(resp.total, 0)
        self.assertEqual(resp.results[0].page_id, pid)

    def test_cjk_two_char_token(self):
        _, _, pid = self._index(
            title="中文搜索测试",
            body_text="这是一个中文搜索功能的测试文档。人工智能技术发展迅速。",
        )
        resp, _ = self._search("搜索")
        self.assertGreater(resp.total, 0)
        self.assertEqual(resp.results[0].page_id, pid)

    def test_korean_token(self):
        _, _, pid = self._index(
            title="한국어 검색",
            body_text="이것은 한국어 검색 테스트입니다. 서울은 한국의 수도입니다.",
        )
        resp, _ = self._search("서울")
        self.assertGreater(resp.total, 0)
        self.assertEqual(resp.results[0].page_id, pid)

    def test_english_fulltext_still_works(self):
        _, _, pid = self._index(
            title="Machine Learning Overview",
            body_text="Machine learning is a subset of artificial intelligence.",
        )
        resp, _ = self._search("artificial intelligence")
        self.assertGreater(resp.total, 0)

    def test_search_scoped_to_user(self):
        other_user = str(uuid.uuid4())
        self._index(title="Private doc", body_text="secret content", user_id=other_user)
        resp, _ = self._search("secret")
        self.assertEqual(resp.total, 0)

    def test_snippet_in_results(self):
        self._index(
            title="Test Page",
            body_text="The quick brown fox jumps over the lazy dog.",
        )
        resp, _ = self._search("brown fox")
        self.assertGreater(len(resp.results), 0)
        self.assertTrue(resp.results[0].snippet)

    def test_empty_query_returns_error(self):
        ctx = _FakeRpcContext()
        req = search_pb2.SearchRequest(query="", user_id=self._user_id)
        self.svc.Search(req, ctx)
        self.assertEqual(ctx.code, grpc.StatusCode.INVALID_ARGUMENT)


class _FakeRpcContext:
    def __init__(self):
        self.code = None
        self.details = None

    def set_code(self, code):
        self.code = code

    def set_details(self, details):
        self.details = details


if __name__ == "__main__":
    unittest.main()
