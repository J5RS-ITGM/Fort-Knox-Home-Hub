"""Voice routes.

  voice_router        /api/voice/*          signed-in users (token, config, numbers)
  admin_router (here) /api/admin/voice/*    admins: credentials, allow-list CRUD, status
  webhook_router      /api/voice/twiml/*    Twilio only — no session, signature-verified

See app/voice.py for the rules these routes enforce.
"""
from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models, voice
from ..auth import audit, get_current_user, require_admin
from ..bridge import put_setting
from ..config import get_settings
from ..db import get_session

log = logging.getLogger("homehub.voice")

voice_router = APIRouter(prefix="/api/voice", tags=["voice"], dependencies=[Depends(get_current_user)])
voice_admin_router = APIRouter(prefix="/api/admin/voice", tags=["voice-admin"], dependencies=[Depends(require_admin)])
webhook_router = APIRouter(prefix="/api/voice/twiml", tags=["voice-webhooks"])  # NO auth dependency: Twilio calls these


# ============================ signed-in ======================================
class TokenIn(BaseModel):
    device_id: str = Field(min_length=4, max_length=64)


@voice_router.post("/token")
async def token(
    body: TokenIn,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> dict:
    """Browser access token for the Twilio Voice SDK. Identity is per DEVICE
    so every panel rings on an inbound call. Only panels/kiosks call this
    (phones use their own dialer)."""
    ident = "panel-" + re.sub(r"[^A-Za-z0-9_-]", "", body.device_id)[:40]
    try:
        jwt = await voice.mint_token(db, ident)
    except RuntimeError as e:
        raise HTTPException(503, str(e)) from e
    return {"token": jwt, "identity": ident, "ttl": voice.TOKEN_TTL}


@voice_router.get("/config")
async def config(db: AsyncSession = Depends(get_session)) -> dict:
    return await voice.public_config(db)


@voice_router.get("/numbers")
async def numbers(db: AsyncSession = Depends(get_session)) -> list[dict]:
    """The allow-list, for the dialer's contact list (read-only here)."""
    return [
        {"id": n.id, "name": n.name, "number": n.number, "pretty": voice.pretty(n.number)}
        for n in await voice.allowed_numbers(db)
    ]


class CallLogIn(BaseModel):
    to: str = Field(max_length=32)
    kind: str = Field(pattern="^(hold_start|hold_cancel|dial|connected|ended|failed)$")
    detail: str = Field(default="", max_length=200)


@voice_router.post("/log", status_code=204)
async def call_log(
    body: CallLogIn,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> None:
    """Client-side call events into the audit log (who held 911, when the
    call connected, etc.). The server-side webhook events are logged too."""
    via = " (via kiosk)" if getattr(user, "kiosk", False) else ""
    await audit(db, user.username, f"voice_{body.kind}", f"{body.to} {body.detail}{via}".strip())


# ============================ admin ==========================================
class CredsIn(BaseModel):
    account_sid: str = Field(default="", max_length=64)
    auth_token: str = Field(default="", max_length=128)
    api_key_sid: str = Field(default="", max_length=64)
    api_key_secret: str = Field(default="", max_length=128)
    twiml_app_sid: str = Field(default="", max_length=64)


@voice_admin_router.get("/status")
async def status(db: AsyncSession = Depends(get_session)) -> dict:
    return await voice.admin_status(db)


@voice_admin_router.put("/credentials")
async def set_credentials(
    body: CredsIn,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> dict:
    """Set any subset of the Twilio secrets. Blank fields are left as they
    are, so a partial update never wipes a working credential."""
    pairs = [
        (voice.K_ACCOUNT_SID, body.account_sid), (voice.K_AUTH_TOKEN, body.auth_token),
        (voice.K_API_KEY_SID, body.api_key_sid), (voice.K_API_KEY_SECRET, body.api_key_secret),
        (voice.K_TWIML_APP_SID, body.twiml_app_sid),
    ]
    changed = []
    for key, val in pairs:
        if val.strip():
            await voice.set_secret(db, key, val)
            changed.append(key)
    if changed:
        await audit(db, admin.username, "voice_credentials_set", ", ".join(changed))
    return await voice.admin_status(db)


@voice_admin_router.post("/credentials/clear")
async def clear_credentials(
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> dict:
    for k in voice.SECRET_KEYS:
        await voice.clear_secret(db, k)
    await audit(db, admin.username, "voice_credentials_cleared", "")
    return await voice.admin_status(db)


class VoiceSettingsIn(BaseModel):
    number: str | None = Field(default=None, max_length=32)
    e911_address: str | None = Field(default=None, max_length=200)
    hold_secs: int | None = Field(default=None, ge=1, le=3)
    auto_show_911: bool | None = None


@voice_admin_router.put("/settings")
async def set_settings(
    body: VoiceSettingsIn,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> dict:
    if body.number is not None:
        if body.number.strip():
            e164 = voice.normalize(body.number)
            if not e164 or e164 in voice.EMERGENCY:
                raise HTTPException(422, "enter the Twilio number as a normal US number, e.g. (630) 555-0148")
            await put_setting(db, voice.K_NUMBER, e164)
        else:
            await put_setting(db, voice.K_NUMBER, "")
    if body.e911_address is not None:
        await put_setting(db, voice.K_E911_ADDRESS, body.e911_address.strip())
    if body.hold_secs is not None:
        await put_setting(db, voice.K_HOLD_SECS, str(body.hold_secs))
    if body.auto_show_911 is not None:
        await put_setting(db, voice.K_AUTO_SHOW, "1" if body.auto_show_911 else "0")
    await audit(db, admin.username, "voice_settings_updated", "")
    return await voice.admin_status(db)


@voice_admin_router.get("/emergency-status")
async def e911_status(db: AsyncSession = Depends(get_session)) -> dict:
    """Read-only check with Twilio: is the number's E911 address registered?"""
    return await voice.emergency_status(db)


class NumberIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    number: str = Field(min_length=3, max_length=32)


@voice_admin_router.get("/numbers")
async def admin_numbers(db: AsyncSession = Depends(get_session)) -> list[dict]:
    return [
        {"id": n.id, "name": n.name, "number": n.number, "pretty": voice.pretty(n.number), "created_by": n.created_by}
        for n in await voice.allowed_numbers(db)
    ]


@voice_admin_router.post("/numbers", status_code=201)
async def add_number(
    body: NumberIn,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> dict:
    e164 = voice.normalize(body.number)
    if not e164:
        raise HTTPException(422, "not a valid phone number")
    if e164 in voice.EMERGENCY:
        raise HTTPException(422, "911 is always allowed and is never listed")
    if await voice.is_allowed(db, e164):
        raise HTTPException(409, "that number is already on the list")
    row = models.AllowedNumber(name=body.name.strip(), number=e164, created_by=admin.username)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    await audit(db, admin.username, "voice_number_added", f"{row.name} {e164}")
    return {"id": row.id, "name": row.name, "number": row.number, "pretty": voice.pretty(row.number)}


@voice_admin_router.put("/numbers/{number_id}")
async def edit_number(
    number_id: str,
    body: NumberIn,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> dict:
    row = await db.get(models.AllowedNumber, number_id)
    if row is None:
        raise HTTPException(404, "no such number")
    e164 = voice.normalize(body.number)
    if not e164 or e164 in voice.EMERGENCY:
        raise HTTPException(422, "not a valid phone number")
    row.name = body.name.strip()
    row.number = e164
    await db.commit()
    await audit(db, admin.username, "voice_number_edited", f"{row.name} {e164}")
    return {"id": row.id, "name": row.name, "number": row.number, "pretty": voice.pretty(row.number)}


@voice_admin_router.delete("/numbers/{number_id}", status_code=204)
async def remove_number(
    number_id: str,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> None:
    row = await db.get(models.AllowedNumber, number_id)
    if row is None:
        raise HTTPException(404, "no such number")
    await db.delete(row)
    await db.commit()
    await audit(db, admin.username, "voice_number_removed", f"{row.name} {row.number}")


# ============================ Twilio webhooks ================================
# These have NO session auth (Twilio is the caller). Every request must carry
# a valid X-Twilio-Signature computed over the public URL + form body with
# our auth token, or it is rejected before any logic runs.

def _public_url(request: Request) -> str:
    """The URL Twilio signed: our configured public origin + this path. Using
    the configured origin (not request.url) is what makes signature checks
    work behind Caddy / the reverse proxy."""
    return f"{get_settings().public_origin}{request.url.path}"


async def _verified_form(request: Request, db: AsyncSession) -> dict:
    form = {k: v for k, v in (await request.form()).items()}
    sig = request.headers.get("X-Twilio-Signature")
    if not await voice.verify_signature(db, _public_url(request), form, sig):
        log.warning("voice webhook rejected: bad or missing signature on %s", request.url.path)
        raise HTTPException(403, "bad signature")
    return form


def _xml(body: str) -> Response:
    return Response(content=body, media_type="application/xml")


@webhook_router.post("/outbound")
async def twiml_outbound(request: Request, db: AsyncSession = Depends(get_session)) -> Response:
    """A browser (panel) connected through our TwiML App with a `To` param.
    This is the ONLY way a call leaves this system, and it always originates
    from a human at a device with a live microphone."""
    form = await _verified_form(request, db)
    raw_to = str(form.get("To", ""))
    ident = str(form.get("From", ""))  # "client:panel-…"
    e164 = voice.normalize(raw_to)
    caller_id = await voice._get(db, voice.K_NUMBER)  # noqa: SLF001
    if not caller_id:
        await audit(db, "twilio", "voice_outbound_refused", f"{raw_to}: no Twilio number configured")
        return _xml(voice.twiml_refuse("The phone line is not set up yet."))
    if not e164:
        await audit(db, "twilio", "voice_outbound_refused", f"{raw_to}: not a valid number ({ident})")
        return _xml(voice.twiml_refuse("That is not a valid number."))
    if e164 in voice.EMERGENCY:
        # 911 (or the 933 test line). Open the callback window so the
        # dispatcher can reach the panel even though they're not on the list.
        await voice.open_callback_window(db)
        await audit(db, "twilio", "voice_emergency_dial", f"{e164} from {ident}")
        return _xml(voice.twiml_dial_number(e164, caller_id, f"{get_settings().public_origin}/api/voice/twiml/status"))
    if not await voice.is_allowed(db, e164):
        await audit(db, "twilio", "voice_outbound_refused", f"{e164} not on allow-list ({ident})")
        return _xml(voice.twiml_refuse("That number is not on the allowed list. Ask an admin to add it."))
    await audit(db, "twilio", "voice_outbound_dial", f"{e164} from {ident}")
    return _xml(voice.twiml_dial_number(e164, caller_id, f"{get_settings().public_origin}/api/voice/twiml/status"))


@webhook_router.post("/inbound")
async def twiml_inbound(request: Request, db: AsyncSession = Depends(get_session)) -> Response:
    """Someone called our Twilio number. Ring every registered panel if the
    caller is on the allow-list, or if a 911 call opened the callback window."""
    form = await _verified_form(request, db)
    frm = str(form.get("From", ""))
    e164 = voice.normalize(frm) or frm
    allowed = await voice.is_allowed(db, e164) or await voice.callback_window_open(db)
    if not allowed:
        await audit(db, "twilio", "voice_inbound_rejected", f"{e164} not on allow-list")
        return _xml(voice.twiml_reject())
    clients = voice.live_clients()
    await audit(db, "twilio", "voice_inbound_ring", f"{e164} -> {len(clients)} panel(s)")
    return _xml(voice.twiml_ring_clients(clients, frm))


@webhook_router.post("/status")
async def twiml_status(request: Request, db: AsyncSession = Depends(get_session)) -> Response:
    """Call progress from Twilio (ringing / answered / completed) → audit."""
    form = await _verified_form(request, db)
    to = str(form.get("To") or form.get("Called") or "")
    await audit(db, "twilio", f"voice_call_{form.get('CallStatus', 'unknown')}", f"{to} {form.get('CallDuration', '')}s".strip())
    return Response(status_code=204)
