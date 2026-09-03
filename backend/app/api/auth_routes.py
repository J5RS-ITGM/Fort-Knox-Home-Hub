"""Auth + admin routes.

/api/auth/setup   — creates the first admin; only works while zero users
                    exist, then is sealed forever.
/api/auth/login   — rate limited; sets the session cookie.
/api/auth/logout  — destroys the server-side session.
/api/auth/me      — current user.
/api/auth/password— change own password (re-auth with current password).

/api/admin/*      — user management + audit log, admin role only.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..auth import (
    audit, check_rate_limit, clear_failures, clear_session_cookie,
    create_session, destroy_session, destroy_user_sessions, get_current_user,
    hash_password, record_failure, require_admin, set_session_cookie,
    verify_password, COOKIE_NAME,
)
from ..db import get_session
from ..schemas import (
    AuditOut, ChangePassword, LoginIn, SetupIn, UserCreate, UserOut, UserPatch,
)

log = logging.getLogger("homehub.auth")

auth_router = APIRouter(prefix="/api/auth", tags=["auth"])
admin_router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])

MIN_PASSWORD = 10


def _validate_password(pw: str) -> None:
    if len(pw) < MIN_PASSWORD:
        raise HTTPException(422, f"password must be at least {MIN_PASSWORD} characters")


# -- first-run setup ---------------------------------------------------------
@auth_router.get("/setup")
async def setup_status(db: AsyncSession = Depends(get_session)) -> dict:
    count = (await db.execute(select(func.count()).select_from(models.User))).scalar_one()
    return {"needs_setup": count == 0}


@auth_router.post("/setup", response_model=UserOut, status_code=201)
async def setup(body: SetupIn, response: Response, db: AsyncSession = Depends(get_session)) -> models.User:
    count = (await db.execute(select(func.count()).select_from(models.User))).scalar_one()
    if count > 0:
        raise HTTPException(403, "setup already completed")
    _validate_password(body.password)
    user = models.User(
        username=body.username.strip().lower(),
        display_name=body.display_name or body.username,
        role="admin",
        password_hash=hash_password(body.password),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    await audit(db, user.username, "setup", "initial admin created")
    set_session_cookie(response, await create_session(db, user))
    log.warning("Initial admin '%s' created via first-run setup", user.username)
    return user


# -- login / logout / me -----------------------------------------------------
@auth_router.post("/login", response_model=UserOut)
async def login(
    body: LoginIn, request: Request, response: Response, db: AsyncSession = Depends(get_session)
) -> models.User:
    username = body.username.strip().lower()
    ip = request.client.host if request.client else "?"
    check_rate_limit(username, ip)

    result = await db.execute(select(models.User).where(models.User.username == username))
    user = result.scalar_one_or_none()
    if user is None or user.disabled or not verify_password(body.password, user.password_hash):
        record_failure(username, ip)
        await audit(db, username, "login_failed", f"ip={ip}")
        raise HTTPException(401, "invalid credentials")

    clear_failures(username, ip)
    set_session_cookie(response, await create_session(db, user))
    await audit(db, username, "login", f"ip={ip}")
    return user


@auth_router.post("/logout", status_code=204)
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_session)) -> None:
    await destroy_session(db, request.cookies.get(COOKIE_NAME))
    clear_session_cookie(response)


@auth_router.get("/me", response_model=UserOut)
async def me(user: models.User = Depends(get_current_user)) -> models.User:
    return user


@auth_router.post("/password", status_code=204)
async def change_password(
    body: ChangePassword,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> None:
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(401, "current password is incorrect")
    _validate_password(body.new_password)
    user.password_hash = hash_password(body.new_password)
    await db.commit()
    await destroy_user_sessions(db, user.id)  # sign out everywhere
    await audit(db, user.username, "password_changed")


# -- admin: users ------------------------------------------------------------
@admin_router.get("/users", response_model=list[UserOut])
async def list_users(db: AsyncSession = Depends(get_session)) -> list[models.User]:
    result = await db.execute(select(models.User).order_by(models.User.created_at))
    return list(result.scalars())


@admin_router.post("/users", response_model=UserOut, status_code=201)
async def create_user(
    body: UserCreate,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> models.User:
    username = body.username.strip().lower()
    exists = (await db.execute(select(models.User).where(models.User.username == username))).scalar_one_or_none()
    if exists:
        raise HTTPException(409, "username already exists")
    if body.role not in ("admin", "member"):
        raise HTTPException(422, "role must be admin or member")
    _validate_password(body.password)
    user = models.User(
        username=username,
        display_name=body.display_name or body.username,
        role=body.role,
        password_hash=hash_password(body.password),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    await audit(db, admin.username, "user_created", f"{username} role={body.role}")
    return user


@admin_router.patch("/users/{user_id}", response_model=UserOut)
async def patch_user(
    user_id: str,
    body: UserPatch,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> models.User:
    user = await db.get(models.User, user_id)
    if user is None:
        raise HTTPException(404, "no such user")
    changes: list[str] = []
    if body.role is not None:
        if body.role not in ("admin", "member"):
            raise HTTPException(422, "role must be admin or member")
        if user.id == admin.id and body.role != "admin":
            raise HTTPException(422, "you cannot demote yourself")
        user.role = body.role
        changes.append(f"role={body.role}")
    if body.disabled is not None:
        if user.id == admin.id and body.disabled:
            raise HTTPException(422, "you cannot disable yourself")
        user.disabled = body.disabled
        changes.append(f"disabled={body.disabled}")
        if body.disabled:
            await destroy_user_sessions(db, user.id)
    if body.password is not None:
        _validate_password(body.password)
        user.password_hash = hash_password(body.password)
        changes.append("password_reset")
        await destroy_user_sessions(db, user.id)
    if body.display_name is not None:
        user.display_name = body.display_name
        changes.append("display_name")
    await db.commit()
    await db.refresh(user)
    await audit(db, admin.username, "user_updated", f"{user.username}: {', '.join(changes) or 'no-op'}")
    return user


# -- admin: audit log --------------------------------------------------------
@admin_router.get("/audit", response_model=list[AuditOut])
async def list_audit(limit: int = 100, db: AsyncSession = Depends(get_session)) -> list[models.AuditLog]:
    limit = max(1, min(limit, 500))
    result = await db.execute(select(models.AuditLog).order_by(models.AuditLog.id.desc()).limit(limit))
    return list(result.scalars())
