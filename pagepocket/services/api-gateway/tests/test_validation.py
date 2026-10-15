"""Unit tests for bounded request-size validation (task 4.4 shared helper).

The ingest route in routers/archive.py is wired by its owning agent; these
tests pin the helper contract: content-length pre-check + bounded reads that
raise before an oversized body is fully buffered.
"""

import asyncio
import unittest

from validation import (
    DEFAULT_MAX_UPLOAD_BYTES,
    READ_CHUNK_SIZE,
    PayloadTooLarge,
    content_length_exceeds,
    max_upload_bytes,
    read_bounded,
)


class _FakeUpload:
    """Mimics starlette's UploadFile.read(n) over an in-memory payload."""

    def __init__(self, data: bytes):
        self._data = data
        self._pos = 0
        self.read_calls = 0

    async def read(self, size: int) -> bytes:
        self.read_calls += 1
        chunk = self._data[self._pos:self._pos + size]
        self._pos += len(chunk)
        return chunk


class TestContentLengthPreCheck(unittest.TestCase):
    def test_missing_content_length_passes(self):
        self.assertFalse(content_length_exceeds(None, 1024))

    def test_under_cap_passes(self):
        self.assertFalse(content_length_exceeds(1000, 1024))

    def test_equal_to_cap_passes(self):
        self.assertFalse(content_length_exceeds(1024, 1024))

    def test_over_cap_fails(self):
        self.assertTrue(content_length_exceeds(1025, 1024))


class TestReadBounded(unittest.TestCase):
    def test_small_upload_reads_fully(self):
        data = b"hello world"
        result = asyncio.run(read_bounded(_FakeUpload(data), max_bytes=1024, chunk_size=4))
        self.assertEqual(result, data)

    def test_exact_cap_allowed(self):
        data = b"x" * 8
        result = asyncio.run(read_bounded(_FakeUpload(data), max_bytes=8, chunk_size=3))
        self.assertEqual(result, data)

    def test_oversized_upload_raises_before_buffering(self):
        data = b"x" * 100
        upload = _FakeUpload(data)
        with self.assertRaises(PayloadTooLarge):
            asyncio.run(read_bounded(upload, max_bytes=10, chunk_size=4))
        # Bounded reads: the reader stopped well before consuming the body.
        self.assertLess(upload._pos, len(data))

    def test_default_chunk_size_is_bounded(self):
        self.assertLessEqual(READ_CHUNK_SIZE, 1024 * 1024)


class TestMaxUploadBytes(unittest.TestCase):
    def test_default_matches_channel_limit(self):
        with unittest.mock.patch.dict("os.environ", {}, clear=False):
            import os

            old = os.environ.pop("MAX_UPLOAD_BYTES", None)
            try:
                self.assertEqual(max_upload_bytes(), DEFAULT_MAX_UPLOAD_BYTES)
                self.assertEqual(DEFAULT_MAX_UPLOAD_BYTES, 256 * 1024 * 1024)
            finally:
                if old is not None:
                    os.environ["MAX_UPLOAD_BYTES"] = old

    def test_env_override(self):
        with unittest.mock.patch.dict("os.environ", {"MAX_UPLOAD_BYTES": "1048576"}):
            self.assertEqual(max_upload_bytes(), 1048576)

    def test_garbage_or_negative_falls_back_to_default(self):
        with unittest.mock.patch.dict("os.environ", {"MAX_UPLOAD_BYTES": "not-a-number"}):
            self.assertEqual(max_upload_bytes(), DEFAULT_MAX_UPLOAD_BYTES)
        with unittest.mock.patch.dict("os.environ", {"MAX_UPLOAD_BYTES": "-5"}):
            self.assertEqual(max_upload_bytes(), DEFAULT_MAX_UPLOAD_BYTES)


if __name__ == "__main__":
    unittest.main()
