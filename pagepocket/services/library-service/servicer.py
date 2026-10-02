"""Library service gRPC servicer implementation."""

import os
import sys

import grpc
from sqlalchemy import func, select

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import library_pb2
import library_pb2_grpc
from cache import cache_delete, cache_get, cache_invalidate_pattern, cache_set
from cache_config import (
    TTL_MEDIUM,
    TTL_SHORT,
    key_collection,
    key_collection_page_ids,
    key_collections_list,
    pattern_collections,
)
from db import db_session, get_engine
from models import Collection, PageCollection


def _coll_to_dict(c, page_count):
    return {
        "id": c.id,
        "user_id": c.user_id,
        "name": c.name,
        "description": c.description or "",
        "parent_id": c.parent_id or "",
        "color": c.color,
        "page_count": page_count,
        "created_at": c.created_at.isoformat(),
        "updated_at": c.updated_at.isoformat(),
    }


def _dict_to_response(d):
    return library_pb2.CollectionResponse(**d)


class LibraryServicer(library_pb2_grpc.LibraryServiceServicer):
    def __init__(self):
        self.engine = get_engine()

    def CreateCollection(self, request, context):
        if not request.name.strip():
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("Name is required")
            return library_pb2.CollectionResponse()

        with db_session(self.engine) as session:
            parent_id = request.parent_id or None
            if parent_id:
                parent = session.execute(
                    select(Collection).where(Collection.id == parent_id)
                ).scalar_one_or_none()
                if not parent or parent.user_id != request.user_id:
                    context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
                    context.set_details("Invalid parent_id")
                    return library_pb2.CollectionResponse()

            color = request.color or "#6B7280"
            coll = Collection(
                user_id=request.user_id,
                name=request.name.strip(),
                description=request.description or None,
                parent_id=parent_id,
                color=color,
            )
            session.add(coll)
            session.flush()

            cache_invalidate_pattern(pattern_collections(request.user_id))

            return library_pb2.CollectionResponse(
                id=coll.id,
                user_id=coll.user_id,
                name=coll.name,
                description=coll.description or "",
                parent_id=coll.parent_id or "",
                color=coll.color,
                page_count=0,
                created_at=coll.created_at.isoformat(),
                updated_at=coll.updated_at.isoformat(),
            )

    def GetCollection(self, request, context):
        ck = key_collection(request.collection_id)
        cached = cache_get(ck)
        if cached and cached.get("user_id") == request.user_id:
            return _dict_to_response(cached)

        with db_session(self.engine) as session:
            coll = session.execute(
                select(Collection).where(Collection.id == request.collection_id)
            ).scalar_one_or_none()

            if not coll or coll.user_id != request.user_id:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Collection not found")
                return library_pb2.CollectionResponse()

            page_count = session.execute(
                select(func.count()).select_from(PageCollection).where(
                    PageCollection.collection_id == coll.id
                )
            ).scalar()

            data = _coll_to_dict(coll, page_count)
            cache_set(ck, data, TTL_MEDIUM)
            return _dict_to_response(data)

    def ListCollections(self, request, context):
        parent_id = request.parent_id or ""
        ck = key_collections_list(request.user_id, parent_id)
        cached = cache_get(ck)
        if cached is not None:
            return library_pb2.ListCollectionsResponse(
                collections=[_dict_to_response(c) for c in cached]
            )

        with db_session(self.engine) as session:
            query = select(Collection).where(Collection.user_id == request.user_id)
            if parent_id:
                query = query.where(Collection.parent_id == parent_id)
            else:
                query = query.where(Collection.parent_id.is_(None))

            collections = session.execute(query).scalars().all()
            results = []
            for c in collections:
                page_count = session.execute(
                    select(func.count()).select_from(PageCollection).where(
                        PageCollection.collection_id == c.id
                    )
                ).scalar()
                results.append(_coll_to_dict(c, page_count))

            cache_set(ck, results, TTL_SHORT)
            return library_pb2.ListCollectionsResponse(
                collections=[_dict_to_response(c) for c in results]
            )

    def UpdateCollection(self, request, context):
        with db_session(self.engine) as session:
            coll = session.execute(
                select(Collection).where(Collection.id == request.collection_id)
            ).scalar_one_or_none()

            if not coll or coll.user_id != request.user_id:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Collection not found")
                return library_pb2.CollectionResponse()

            if request.name:
                coll.name = request.name
            if request.description:
                coll.description = request.description
            if request.color:
                coll.color = request.color

            page_count = session.execute(
                select(func.count()).select_from(PageCollection).where(
                    PageCollection.collection_id == coll.id
                )
            ).scalar()

            data = _coll_to_dict(coll, page_count)
            user_id = coll.user_id

        cache_delete(key_collection(request.collection_id))
        cache_invalidate_pattern(pattern_collections(user_id))

        return _dict_to_response(data)

    def DeleteCollection(self, request, context):
        with db_session(self.engine) as session:
            coll = session.execute(
                select(Collection).where(Collection.id == request.collection_id)
            ).scalar_one_or_none()

            if not coll or coll.user_id != request.user_id:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Collection not found")
                return library_pb2.StatusResponse()

            user_id = coll.user_id
            session.delete(coll)

        cache_delete(key_collection(request.collection_id))
        cache_delete(key_collection_page_ids(request.collection_id))
        cache_invalidate_pattern(pattern_collections(user_id))
        return library_pb2.StatusResponse(success=True)

    def AddPageToCollection(self, request, context):
        with db_session(self.engine) as session:
            coll = session.execute(
                select(Collection).where(Collection.id == request.collection_id)
            ).scalar_one_or_none()

            if not coll or coll.user_id != request.user_id:
                context.set_code(grpc.StatusCode.PERMISSION_DENIED)
                context.set_details("Collection not owned by user")
                return library_pb2.StatusResponse()

            existing = session.execute(
                select(PageCollection).where(
                    PageCollection.page_id == request.page_id,
                    PageCollection.collection_id == request.collection_id,
                )
            ).scalar_one_or_none()

            if not existing:
                pc = PageCollection(
                    page_id=request.page_id,
                    collection_id=request.collection_id,
                )
                session.add(pc)
            user_id = coll.user_id

        cache_delete(key_collection(request.collection_id))
        cache_delete(key_collection_page_ids(request.collection_id))
        cache_invalidate_pattern(pattern_collections(user_id))
        return library_pb2.StatusResponse(success=True)

    def RemovePageFromCollection(self, request, context):
        with db_session(self.engine) as session:
            coll = session.execute(
                select(Collection).where(Collection.id == request.collection_id)
            ).scalar_one_or_none()

            if not coll or coll.user_id != request.user_id:
                context.set_code(grpc.StatusCode.PERMISSION_DENIED)
                context.set_details("Collection not owned by user")
                return library_pb2.StatusResponse()

            session.query(PageCollection).filter(
                PageCollection.page_id == request.page_id,
                PageCollection.collection_id == request.collection_id,
            ).delete()
            user_id = coll.user_id

        cache_delete(key_collection(request.collection_id))
        cache_delete(key_collection_page_ids(request.collection_id))
        cache_invalidate_pattern(pattern_collections(user_id))
        return library_pb2.StatusResponse(success=True)

    def ListCollectionPageIds(self, request, context):
        ck = key_collection_page_ids(request.collection_id)
        cached = cache_get(ck)
        if cached is not None:
            return library_pb2.ListCollectionPageIdsResponse(page_ids=cached)

        with db_session(self.engine) as session:
            coll = session.execute(
                select(Collection).where(Collection.id == request.collection_id)
            ).scalar_one_or_none()

            if not coll or coll.user_id != request.user_id:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Collection not found")
                return library_pb2.ListCollectionPageIdsResponse()

            rows = session.execute(
                select(PageCollection.page_id).where(
                    PageCollection.collection_id == request.collection_id
                )
            ).scalars().all()

            page_ids = list(rows)
            cache_set(ck, page_ids, TTL_SHORT)
            return library_pb2.ListCollectionPageIdsResponse(page_ids=page_ids)
