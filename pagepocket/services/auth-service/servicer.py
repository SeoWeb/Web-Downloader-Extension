"""Auth service gRPC servicer implementation."""

import hashlib
import logging
import os
import re
import sys
from datetime import UTC, datetime

import grpc
from passlib.context import CryptContext
from sqlalchemy import select

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared", "proto_generated"))

import auth_pb2
import auth_pb2_grpc

# StatusResponse lives in common.proto (single source of truth since
# harden-pagepocket-platform): auth.proto no longer defines its own.
import common_pb2
from db import db_session, get_engine
from jwt_utils import issue_access_token, issue_refresh_token, verify_access_token
from models import RefreshToken, User

logger = logging.getLogger(__name__)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _bcrypt_truncate(password: str) -> str:
    return password.encode("utf-8")[:72].decode("utf-8", errors="ignore")


class AuthServicer(auth_pb2_grpc.AuthServiceServicer):
    def __init__(self):
        self.engine = get_engine()

    def Register(self, request, context):
        email = request.email.strip().lower()
        password = request.password
        name = request.name.strip()

        if not email or not _EMAIL_RE.match(email):
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("Invalid email")
            return auth_pb2.AuthResponse()

        if not password or len(password) < 8:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("Password must be at least 8 characters")
            return auth_pb2.AuthResponse()

        if not name:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("Name is required")
            return auth_pb2.AuthResponse()

        with db_session(self.engine) as session:
            existing = session.execute(select(User).where(User.email == email)).scalar_one_or_none()
            if existing:
                context.set_code(grpc.StatusCode.ALREADY_EXISTS)
                context.set_details("Email already registered")
                return auth_pb2.AuthResponse()

            password_hash = pwd_context.hash(_bcrypt_truncate(password))
            user = User(email=email, password_hash=password_hash, name=name, plan="free", is_verified=False)
            session.add(user)
            session.flush()

            access_token, expires_at = issue_access_token(user.id, user.email, user.plan)
            raw_refresh, refresh_hash, refresh_expires = issue_refresh_token()
            rt = RefreshToken(
                user_id=user.id,
                token_hash=refresh_hash,
                expires_at=datetime.fromtimestamp(refresh_expires, tz=UTC),
            )
            session.add(rt)

            return auth_pb2.AuthResponse(
                access_token=access_token,
                refresh_token=raw_refresh,
                expires_at=expires_at,
                user=auth_pb2.User(
                    id=user.id,
                    email=user.email,
                    name=user.name,
                    plan=user.plan,
                    is_verified=user.is_verified,
                    created_at=user.created_at.isoformat(),
                ),
            )

    def Login(self, request, context):
        email = request.email.strip().lower()
        password = request.password

        with db_session(self.engine) as session:
            user = session.execute(select(User).where(User.email == email)).scalar_one_or_none()
            if not user or not pwd_context.verify(_bcrypt_truncate(password), user.password_hash):
                context.set_code(grpc.StatusCode.UNAUTHENTICATED)
                context.set_details("invalid credentials")
                return auth_pb2.AuthResponse()

            access_token, expires_at = issue_access_token(user.id, user.email, user.plan)
            raw_refresh, refresh_hash, refresh_expires = issue_refresh_token()
            rt = RefreshToken(
                user_id=user.id,
                token_hash=refresh_hash,
                expires_at=datetime.fromtimestamp(refresh_expires, tz=UTC),
            )
            session.add(rt)

            return auth_pb2.AuthResponse(
                access_token=access_token,
                refresh_token=raw_refresh,
                expires_at=expires_at,
                user=auth_pb2.User(
                    id=user.id,
                    email=user.email,
                    name=user.name,
                    plan=user.plan,
                    is_verified=user.is_verified,
                    created_at=user.created_at.isoformat(),
                ),
            )

    def Verify(self, request, context):
        payload = verify_access_token(request.token)
        if payload is None:
            return auth_pb2.VerifyResponse(valid=False)
        # The plan claim in the JWT is refreshed at issue time, but a user can
        # change plan mid-token. Read the CURRENT plan from the users table so
        # callers (e.g. the monolith cloud binding) always store the real plan;
        # fall back to the token claims if the user row is gone.
        plan = payload.get("plan", "")
        try:
            with db_session(self.engine) as session:
                user = session.execute(
                    select(User).where(User.id == payload["sub"])
                ).scalar_one_or_none()
                if user is not None:
                    plan = user.plan
        except Exception as exc:
            # DB unavailable — serve the token claims rather than fail Verify.
            logger.warning(
                "Could not read current plan for user %s — serving token claims: %s",
                payload.get("sub"), exc,
            )
        return auth_pb2.VerifyResponse(
            valid=True,
            user_id=payload["sub"],
            email=payload["email"],
            plan=plan,
        )

    def Refresh(self, request, context):
        raw = request.refresh_token
        token_hash = hashlib.sha256(raw.encode()).hexdigest()

        with db_session(self.engine) as session:
            rt = session.execute(
                select(RefreshToken).where(RefreshToken.token_hash == token_hash)
            ).scalar_one_or_none()

            if not rt:
                context.set_code(grpc.StatusCode.UNAUTHENTICATED)
                context.set_details("invalid refresh token")
                return auth_pb2.AuthResponse()

            if rt.revoked_at is not None:
                # Reuse detection: revoke all tokens for this user
                session.query(RefreshToken).filter(RefreshToken.user_id == rt.user_id).update(
                    {"revoked_at": datetime.now(UTC)}
                )
                context.set_code(grpc.StatusCode.UNAUTHENTICATED)
                context.set_details("refresh token reused")
                return auth_pb2.AuthResponse()

            expires_at = rt.expires_at.replace(tzinfo=None) if rt.expires_at.tzinfo else rt.expires_at
            if expires_at < datetime.now(UTC).replace(tzinfo=None):
                context.set_code(grpc.StatusCode.UNAUTHENTICATED)
                context.set_details("refresh token expired")
                return auth_pb2.AuthResponse()

            # Rotation: revoke old, create new (keep row for reuse detection)
            user_id = rt.user_id
            rt.revoked_at = datetime.now(UTC)
            user = session.execute(select(User).where(User.id == user_id)).scalar_one()

            access_token, expires_at = issue_access_token(user.id, user.email, user.plan)
            new_raw, new_hash, new_expires = issue_refresh_token()
            new_rt = RefreshToken(
                user_id=user.id,
                token_hash=new_hash,
                expires_at=datetime.fromtimestamp(new_expires, tz=UTC),
            )
            session.add(new_rt)

            return auth_pb2.AuthResponse(
                access_token=access_token,
                refresh_token=new_raw,
                expires_at=expires_at,
                user=auth_pb2.User(
                    id=user.id,
                    email=user.email,
                    name=user.name,
                    plan=user.plan,
                    is_verified=user.is_verified,
                    created_at=user.created_at.isoformat(),
                ),
            )

    def Logout(self, request, context):
        with db_session(self.engine) as session:
            session.query(RefreshToken).filter(RefreshToken.user_id == request.user_id).delete()
        return common_pb2.StatusResponse(success=True)
