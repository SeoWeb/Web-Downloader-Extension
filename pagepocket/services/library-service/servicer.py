"""Library service gRPC servicer implementation."""

import os
import uuid

import grpc
from sqlalchemy import select, func

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import library_pb2
import library_pb2_grpc
from db import db_session, get_engine
from models import Collection, PageCollection


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

            return library_pb2.CollectionResponse(
                id=coll.id,
                user_id=coll.user_id,
                name=coll.name,
                description=coll.description or "",
                parent_id=coll.parent_id or "",
                color=coll.color,
                page_count=page_count,
                created_at=coll.created_at.isoformat(),
                updated_at=coll.updated_at.isoformat(),
            )

    def ListCollections(self, request, context):
        with db_session(self.engine) as session:
            query = select(Collection).where(Collection.user_id == request.user_id)
            parent_id = request.parent_id or None
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
                results.append(library_pb2.CollectionResponse(
                    id=c.id,
                    user_id=c.user_id,
                    name=c.name,
                    description=c.description or "",
                    parent_id=c.parent_id or "",
                    color=c.color,
                    page_count=page_count,
                    created_at=c.created_at.isoformat(),
                    updated_at=c.updated_at.isoformat(),
                ))
            return library_pb2.ListCollectionsResponse(collections=results)

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

            return library_pb2.CollectionResponse(
                id=coll.id,
                user_id=coll.user_id,
                name=coll.name,
                description=coll.description or "",
                parent_id=coll.parent_id or "",
                color=coll.color,
                page_count=page_count,
                created_at=coll.created_at.isoformat(),
                updated_at=coll.updated_at.isoformat(),
            )

    def DeleteCollection(self, request, context):
        with db_session(self.engine) as session:
            coll = session.execute(
                select(Collection).where(Collection.id == request.collection_id)
            ).scalar_one_or_none()

            if not coll or coll.user_id != request.user_id:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details("Collection not found")
                return library_pb2.StatusResponse()

            session.delete(coll)
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

        return library_pb2.StatusResponse(success=True)
