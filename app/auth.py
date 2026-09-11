"""Authentication core.

Design:
- Passwords: bcrypt.
- Sessions: opaque random token in an HttpOnly+Secure+SameSite=Lax cookie;
  only its SHA-256 is stored, with a server-side expiry. Logout deletes the
  row — revocation is immediate, nothing to "expire" client-side.
- No JWTs, nothing auth-related in localStorage.
- Login attempts are rate limited per username+IP.
"""

import hashlib
import secrets
import time
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import models
from .config import get_settings
from .db import get_session

COOKIE_NAME = "hh_session"


# -- passwords ---------------------------------------------------------------
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    except ValueError:
        return False


# -- sessions ----------------------------------------------------------------
def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def create_session(db: AsyncSession, user: models.User) -> str:
    token = secrets.token_urlsafe(32)
    ttl = timedelta(days=get_settings().session_ttl_days)
    db.add(
        models.Session(
            token_hash=_hash_token(token),
            user_id=user.id,
            expires_at=datetime.now(timezone.utc) + ttl,
        )
    )
    await db.commit()
    return token


async def resolve_session(db: AsyncSession, token: str | None) -> models.User | None:
    if not token:
        return None
    row = await db.get(models.Session, _hash_token(token))
    if row is None:
        return None
    expires = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=timezone.utc)
    if expires < datetime.now(timezone.utc):
        await db.delete(row)
        await db.commit()
        return None
    user = await db.get(models.User, row.user_id)
    if user is None or user.disabled:
        return None
    # carry the session's kiosk-mode flag on the user object for guards
    user.kiosk = bool(row.kiosk) or user.role == "kiosk"
    return user


async def destroy_session(db: AsyncSession, token: str | None) -> None:
    if token:
        await db.execute(delete(models.Session).where(models.Session.token_hash == _hash_token(token)))
        await db.commit()


async def destroy_user_sessions(db: AsyncSession, user_id: str) -> None:
    await db.execute(delete(models.Session).where(models.Session.user_id == user_id))
    await db.commit()


def set_session_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=settings.session_ttl_days * 86400,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")


# -- dependencies ------------------------------------------------------------
async def get_current_user(
    request: Request, db: AsyncSession = Depends(get_session)
) -> models.User:
    user = await resolve_session(db, request.cookies.get(COOKIE_NAME))
    if user is None:
        raise HTTPException(401, "not authenticated")
    return user


async def require_admin(user: models.User = Depends(get_current_user)) -> models.User:
    if user.role != "admin":
        raise HTTPException(403, "admin only")
    if getattr(user, "kiosk", False):
        raise HTTPException(403, "exit kiosk mode to use admin features")
    return user


# -- login rate limiting (in-memory, per-process) ----------------------------
_ATTEMPTS: dict[str, list[float]] = {}
_WINDOW = 300.0  # 5 minutes
_MAX_FAILURES = 5


def check_rate_limit(username: str, ip: str) -> None:
    key = f"{username}|{ip}"
    now = time.monotonic()
    attempts = [t for t in _ATTEMPTS.get(key, []) if now - t < _WINDOW]
    _ATTEMPTS[key] = attempts
    if len(attempts) >= _MAX_FAILURES:
        raise HTTPException(429, "too many failed attempts; try again later")


def record_failure(username: str, ip: str) -> None:
    _ATTEMPTS.setdefault(f"{username}|{ip}", []).append(time.monotonic())


def clear_failures(username: str, ip: str) -> None:
    _ATTEMPTS.pop(f"{username}|{ip}", None)


# -- audit -------------------------------------------------------------------
async def audit(db: AsyncSession, username: str, action: str, detail: str = "") -> None:
    db.add(models.AuditLog(username=username, action=action, detail=detail))
    await db.commit()
