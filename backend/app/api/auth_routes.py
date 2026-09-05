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
    if body.role not in ("admin", "member", "kiosk"):
        raise HTTPException(422, "role must be admin, member, or kiosk")
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
        if body.role not in ("admin", "member", "kiosk"):
            raise HTTPException(422, "role must be admin, member, or kiosk")
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
    if body.pin is not None:
        if not (body.pin.isdigit() and 4 <= len(body.pin) <= 8):
            raise HTTPException(422, "PIN must be 4-8 digits")
        user.pin_hash = hash_password(body.pin)
        changes.append("pin_set")
    if body.clear_pin:
        user.pin_hash = None
        changes.append("pin_cleared")
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


# -- admin: HA bridge configuration ------------------------------------------
from ..bridge import effective_ha_config, manager, put_setting  # noqa: E402
from ..schemas import FamilyIn, FamilyOut, FamilyPatch, HASettingsIn, HASettingsOut  # noqa: E402


@admin_router.get("/settings/ha", response_model=HASettingsOut)
async def get_ha_settings(db: AsyncSession = Depends(get_session)) -> HASettingsOut:
    cfg = await effective_ha_config(db)
    return HASettingsOut(ha_url=cfg["url"], ha_mock=cfg["mock"], token_set=cfg["token_set"], mode=manager.mode)


@admin_router.put("/settings/ha", response_model=HASettingsOut)
async def put_ha_settings(
    body: HASettingsIn,
    admin=Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> HASettingsOut:
    changes: list[str] = []
    if body.ha_url is not None:
        await put_setting(db, "ha_url", body.ha_url.strip())
        changes.append("ha_url")
    if body.ha_mock is not None:
        await put_setting(db, "ha_mock", "true" if body.ha_mock else "false")
        changes.append(f"ha_mock={body.ha_mock}")
    if body.ha_token:
        await put_setting(db, "ha_token", body.ha_token)
        changes.append("ha_token(updated)")
    await audit(db, admin.username, "ha_settings", ", ".join(changes) or "no-op")
    cfg = await effective_ha_config(db)
    return HASettingsOut(ha_url=cfg["url"], ha_mock=cfg["mock"], token_set=cfg["token_set"], mode=manager.mode)


@admin_router.post("/bridge/restart", response_model=HASettingsOut)
async def restart_bridge(admin=Depends(require_admin), db: AsyncSession = Depends(get_session)) -> HASettingsOut:
    mode = await manager.restart()
    await audit(db, admin.username, "bridge_restart", f"now {mode}")
    cfg = await effective_ha_config(db)
    return HASettingsOut(ha_url=cfg["url"], ha_mock=cfg["mock"], token_set=cfg["token_set"], mode=mode)


# -- admin: household roster --------------------------------------------------
@admin_router.get("/family", response_model=list[FamilyOut])
async def list_family(db: AsyncSession = Depends(get_session)) -> list[models.FamilyMember]:
    result = await db.execute(select(models.FamilyMember).order_by(models.FamilyMember.sort, models.FamilyMember.created_at))
    return list(result.scalars())


@admin_router.post("/family", response_model=FamilyOut, status_code=201)
async def create_family(body: FamilyIn, admin=Depends(require_admin), db: AsyncSession = Depends(get_session)) -> models.FamilyMember:
    m = models.FamilyMember(name=body.name.strip(), emoji=body.emoji, color=body.color, sort=body.sort, user_id=body.user_id)
    db.add(m)
    await db.commit()
    await db.refresh(m)
    await audit(db, admin.username, "family_added", m.name)
    return m


@admin_router.patch("/family/{member_id}", response_model=FamilyOut)
async def patch_family(member_id: str, body: FamilyPatch, admin=Depends(require_admin), db: AsyncSession = Depends(get_session)) -> models.FamilyMember:
    m = await db.get(models.FamilyMember, member_id)
    if m is None:
        raise HTTPException(404, "no such member")
    for field in ("name", "emoji", "color", "sort"):
        v = getattr(body, field)
        if v is not None:
            setattr(m, field, v)
    if "user_id" in body.model_fields_set:  # allow explicit null to unlink
        m.user_id = body.user_id
    await db.commit()
    await db.refresh(m)
    await audit(db, admin.username, "family_updated", m.name)
    return m


@admin_router.delete("/family/{member_id}", status_code=204)
async def delete_family(member_id: str, admin=Depends(require_admin), db: AsyncSession = Depends(get_session)) -> None:
    m = await db.get(models.FamilyMember, member_id)
    if m is None:
        raise HTTPException(404, "no such member")
    await db.delete(m)
    await db.commit()
    await audit(db, admin.username, "family_removed", m.name)


# -- admin: placements delete -------------------------------------------------
@admin_router.delete("/placements/{entity_id}", status_code=204)
async def delete_placement(entity_id: str, admin=Depends(require_admin), db: AsyncSession = Depends(get_session)) -> None:
    result = await db.execute(select(models.SensorPlacement).where(models.SensorPlacement.entity_id == entity_id))
    p = result.scalar_one_or_none()
    if p is None:
        raise HTTPException(404, "no such placement")
    await db.delete(p)
    await db.commit()
    await audit(db, admin.username, "placement_deleted", entity_id)


# -- admin: service allowlist ------------------------------------------------
from .. import allowlist as allowlist_mod  # noqa: E402
from ..schemas import AllowIn, AllowOut, SettingOut, SettingsIn  # noqa: E402

_SERVICE_RE = r"^[a-z_][a-z0-9_]*$"


@admin_router.get("/allowlist", response_model=list[AllowOut])
async def list_allowlist(db: AsyncSession = Depends(get_session)) -> list[models.ServiceAllow]:
    result = await db.execute(
        select(models.ServiceAllow).order_by(models.ServiceAllow.domain, models.ServiceAllow.service)
    )
    return list(result.scalars())


@admin_router.post("/allowlist", response_model=AllowOut, status_code=201)
async def add_allow(
    body: AllowIn,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> models.ServiceAllow:
    import re
    domain, service = body.domain.strip().lower(), body.service.strip().lower()
    if not re.match(_SERVICE_RE, domain) or not re.match(_SERVICE_RE, service):
        raise HTTPException(422, "domain and service must be lowercase identifiers")
    exists = (
        await db.execute(
            select(models.ServiceAllow).where(
                models.ServiceAllow.domain == domain, models.ServiceAllow.service == service
            )
        )
    ).scalar_one_or_none()
    if exists:
        raise HTTPException(409, "already allowed")
    row = models.ServiceAllow(domain=domain, service=service, note=body.note)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    await allowlist_mod.refresh(db)
    await audit(db, admin.username, "allowlist_added", f"{domain}.{service} ({body.note or 'no note'})")
    return row


@admin_router.delete("/allowlist/{allow_id}", status_code=204)
async def remove_allow(
    allow_id: str,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> None:
    row = await db.get(models.ServiceAllow, allow_id)
    if row is None:
        raise HTTPException(404, "no such rule")
    await db.delete(row)
    await db.commit()
    await allowlist_mod.refresh(db)
    await audit(db, admin.username, "allowlist_removed", f"{row.domain}.{row.service}")


# -- admin: app settings (non-secret) ----------------------------------------
SETTING_KEYS = {
    "home_name", "latitude", "longitude", "timezone",
    # sensor alert cards (SensorFlash): "all" | "armed_only" | "off",
    # hex colors, and the disarmed auto-dismiss window (seconds, 0 = sticky)
    "alerts_mode", "alert_color_disarmed", "alert_color_armed", "alert_dismiss_secs",
    # per-sensor overrides: JSON {entity_id: "all"|"armed_only"|"off"};
    # entities absent from the map follow alerts_mode
    "alert_rules",
    # appearance: theme preset (light|moderate|dark) + optional accent hex
    "theme_mode", "theme_accent",
}


@admin_router.get("/settings", response_model=list[SettingOut])
async def list_settings(db: AsyncSession = Depends(get_session)) -> list[models.AppSetting]:
    # ONLY the editable, non-secret keys. app_settings also holds the HA
    # bridge config — including the raw ha_token — which must never be
    # returned by any API (architecture rule #2). The HA Bridge endpoints
    # expose token_set as a boolean; nothing else gets the value out.
    result = await db.execute(
        select(models.AppSetting)
        .where(models.AppSetting.key.in_(SETTING_KEYS))
        .order_by(models.AppSetting.key)
    )
    return list(result.scalars())


@admin_router.put("/settings", response_model=list[SettingOut])
async def put_settings(
    body: SettingsIn,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> list[models.AppSetting]:
    bad = set(body.values) - SETTING_KEYS
    if bad:
        raise HTTPException(422, f"unknown setting keys: {', '.join(sorted(bad))}")
    for key, value in body.values.items():
        row = await db.get(models.AppSetting, key)
        if row is None:
            db.add(models.AppSetting(key=key, value=value))
        else:
            row.value = value
    await db.commit()
    await audit(db, admin.username, "settings_updated", ", ".join(sorted(body.values)))
    result = await db.execute(
        select(models.AppSetting)
        .where(models.AppSetting.key.in_(SETTING_KEYS))
        .order_by(models.AppSetting.key)
    )
    return list(result.scalars())



# ============================ Kiosk mode =====================================
# Kiosk mode is a per-SESSION flag toggled with a dedicated kiosk password
# (bcrypt hash in app_settings under KIOSK_PW_KEY — never in SETTING_KEYS,
# so it is never returned by any settings endpoint). Enter → the session's
# UI collapses to the family screens and the backend refuses admin routes
# + destructive actions for that session. Exit → same password, back to
# normal. Rate-limited like login.
from ..auth import _hash_token  # noqa: E402
from pydantic import BaseModel as _BM  # noqa: E402

KIOSK_PW_KEY = "kiosk_password_hash"
kiosk_router = APIRouter(prefix="/api/kiosk", tags=["kiosk"])


class KioskPasswordIn(_BM):
    password: str


class KioskToggleIn(_BM):
    password: str


async def _kiosk_hash(db: AsyncSession) -> str | None:
    row = await db.get(models.AppSetting, KIOSK_PW_KEY)
    return row.value if row and row.value else None


@admin_router.get("/kiosk-password")
async def kiosk_password_status(db: AsyncSession = Depends(get_session)) -> dict:
    return {"set": (await _kiosk_hash(db)) is not None}


@admin_router.put("/kiosk-password")
async def set_kiosk_password(
    body: KioskPasswordIn,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> dict:
    if len(body.password) < 4:
        raise HTTPException(422, "kiosk password must be at least 4 characters")
    await put_setting(db, KIOSK_PW_KEY, hash_password(body.password))
    await db.commit()
    await audit(db, admin.username, "kiosk_password_set", "")
    return {"set": True}


async def _toggle_kiosk(request: Request, body: KioskToggleIn, user: models.User,
                        db: AsyncSession, on: bool) -> dict:
    ip = request.client.host if request.client else "?"
    check_rate_limit(f"kiosk:{user.username}", ip)
    stored = await _kiosk_hash(db)
    if stored is None:
        raise HTTPException(409, "no kiosk password set — set one in Admin → Settings")
    if not verify_password(body.password, stored):
        record_failure(f"kiosk:{user.username}", ip)
        await audit(db, user.username, "kiosk_pw_fail", "enter" if on else "exit")
        raise HTTPException(403, "wrong kiosk password")
    clear_failures(f"kiosk:{user.username}", ip)
    token = request.cookies.get(COOKIE_NAME)
    row = await db.get(models.Session, _hash_token(token)) if token else None
    if row is None:
        raise HTTPException(401, "not authenticated")
    row.kiosk = on
    await db.commit()
    await audit(db, user.username, "kiosk_enter" if on else "kiosk_exit", "")
    return {"kiosk": on}


@kiosk_router.post("/enter")
async def kiosk_enter(
    body: KioskToggleIn, request: Request,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> dict:
    return await _toggle_kiosk(request, body, user, db, True)


@kiosk_router.post("/exit")
async def kiosk_exit(
    body: KioskToggleIn, request: Request,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> dict:
    return await _toggle_kiosk(request, body, user, db, False)


# ============================ Google Calendar ================================
# Admin sets the OAuth client (id/secret), connects the shared family account
# via Google's consent screen, and syncs. All secrets stay server-side.
from fastapi.responses import RedirectResponse  # noqa: E402
from .. import google_cal  # noqa: E402

google_router = APIRouter(prefix="/api/google", tags=["google"])


class GoogleCredsIn(_BM):
    client_id: str
    client_secret: str


class GoogleCalIn(_BM):
    calendar_id: str


@admin_router.get("/google/status")
async def google_status(db: AsyncSession = Depends(get_session)) -> dict:
    return await google_cal.status(db)


@admin_router.put("/google/credentials")
async def google_set_creds(
    body: GoogleCredsIn,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> dict:
    if not body.client_id.strip() or not body.client_secret.strip():
        raise HTTPException(422, "client id and secret required")
    await google_cal.set_credentials(db, body.client_id, body.client_secret)
    await audit(db, admin.username, "google_creds_set", "")
    return await google_cal.status(db)


@admin_router.put("/google/calendar")
async def google_set_calendar(
    body: GoogleCalIn,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> dict:
    from ..bridge import put_setting
    await put_setting(db, google_cal.K_CAL_ID, body.calendar_id.strip() or "primary")
    await audit(db, admin.username, "google_calendar_set", body.calendar_id)
    return await google_cal.status(db)


@admin_router.post("/google/connect")
async def google_connect(
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> dict:
    try:
        url = await google_cal.build_auth_url(db)
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    return {"auth_url": url}


@admin_router.post("/google/disconnect")
async def google_disconnect(
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> dict:
    await google_cal.disconnect(db)
    await audit(db, admin.username, "google_disconnected", "")
    return await google_cal.status(db)


@admin_router.post("/google/sync")
async def google_sync(
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> dict:
    try:
        summary = await google_cal.sync(db)
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"sync failed: {e}") from e
    await audit(db, admin.username, "google_synced", str(summary))
    return summary


# OAuth callback — Google redirects the browser here. Not admin-guarded
# (Google can't send our cookie), but the state parameter is the CSRF check.
@google_router.get("/callback")
async def google_callback(
    request: Request,
    db: AsyncSession = Depends(get_session),
) -> RedirectResponse:
    code = request.query_params.get("code")
    state = request.query_params.get("state", "")
    err = request.query_params.get("error")
    dest = "/admin?google="
    if err:
        return RedirectResponse(f"{dest}error", status_code=302)
    if not code:
        return RedirectResponse(f"{dest}error", status_code=302)
    try:
        await google_cal.handle_callback(db, code, state)
        return RedirectResponse(f"{dest}connected", status_code=302)
    except Exception:  # noqa: BLE001
        return RedirectResponse(f"{dest}error", status_code=302)
