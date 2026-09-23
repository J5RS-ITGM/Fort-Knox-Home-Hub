"""Voice — the wall panel's phone line and 911 button, on Twilio.

Architecture (matches the alarm: the app is a control surface, the rules
live server-side):

  browser (Twilio Voice JS SDK) --token--> backend      : /api/voice/token
  browser --call(To)--> Twilio --webhook--> backend     : /api/voice/twiml/outbound
  PSTN --incoming--> Twilio --webhook--> backend        : /api/voice/twiml/inbound
                                          --> <Dial><Client>panel…</Client></Dial>

Hard rules, all enforced HERE and never only in the UI:

  1. THE BACKEND NEVER PLACES A 911 CALL ON ITS OWN. There is no REST
     "calls.create" anywhere in this module. A 911 call exists only when a
     browser with a live microphone connects and asks for "911" — i.e. a
     person held the button. HA can't reach this; it's not on the service
     allowlist.
  2. Outbound allow-list: the TwiML for a browser call dials the number only
     if it is on `allowed_numbers`. 911 and 933 (Twilio's E911 address
     read-back test) are always allowed. Anything else is refused with a
     spoken message and hung up, and audited.
  3. Inbound allow-list: an incoming call rings the panels only if the
     caller is on `allowed_numbers` — EXCEPT for CALLBACK_WINDOW after a 911
     call, when any number rings, so a dispatcher callback is never blocked.
  4. Every webhook is verified with Twilio's request signature. Unsigned or
     mis-signed requests are rejected before any logic runs.
  5. Credentials live encrypted in app_settings (same Fernet key as the
     Google tokens), set from the Admin page, never in .env or the repo.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import models
from .bridge import put_setting
from .google_cal import _dec, _enc  # shared Fernet helpers

# ---- settings keys ---------------------------------------------------------
# secrets (Fernet-encrypted at rest; never returned by any API)
K_ACCOUNT_SID = "twilio_account_sid"
K_AUTH_TOKEN = "twilio_auth_token"          # needed to verify webhook signatures
K_API_KEY_SID = "twilio_api_key_sid"        # used to mint browser access tokens
K_API_KEY_SECRET = "twilio_api_key_secret"
K_TWIML_APP_SID = "twilio_twiml_app_sid"
# non-secret
K_NUMBER = "voice_number"                   # E.164 Twilio number = caller ID + 911 callback
K_E911_ADDRESS = "voice_e911_address"       # display text of the registered address
K_HOLD_SECS = "voice_hold_secs"             # 1..3, hold-to-call duration for 911
K_AUTO_SHOW = "voice_911_auto_show"         # "1" show 911 on the alarm popup when triggered
K_WINDOW_UNTIL = "voice_callback_until"     # ISO time; any inbound rings until then (post-911)

SECRET_KEYS = {K_ACCOUNT_SID, K_AUTH_TOKEN, K_API_KEY_SID, K_API_KEY_SECRET, K_TWIML_APP_SID}
PUBLIC_KEYS = {K_NUMBER, K_E911_ADDRESS, K_HOLD_SECS, K_AUTO_SHOW}

CALLBACK_WINDOW = timedelta(minutes=30)
EMERGENCY = {"911", "933"}   # 933 = Twilio's E911 test line (reads back the registered address)
TOKEN_TTL = 3600             # seconds; the client refreshes before expiry


# ---- number normalisation --------------------------------------------------
def normalize(raw: str) -> str | None:
    """To E.164 for US/CA; returns None if it can't be a dialable number.
    '911'/'933' pass through untouched."""
    s = (raw or "").strip()
    if s in EMERGENCY:
        return s
    digits = re.sub(r"\D", "", s)
    if s.startswith("+") and 8 <= len(digits) <= 15:
        return "+" + digits
    if len(digits) == 10:
        return "+1" + digits
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    return None


def pretty(e164: str) -> str:
    d = re.sub(r"\D", "", e164 or "")
    if len(d) == 11 and d.startswith("1"):
        return f"({d[1:4]}) {d[4:7]}-{d[7:]}"
    return e164


# ---- settings access -------------------------------------------------------
async def _get(db: AsyncSession, key: str) -> str | None:
    row = await db.get(models.AppSetting, key)
    return row.value if row else None


async def get_secret(db: AsyncSession, key: str) -> str | None:
    return _dec(await _get(db, key))


async def set_secret(db: AsyncSession, key: str, value: str) -> None:
    await put_setting(db, key, _enc(value.strip()))


async def clear_secret(db: AsyncSession, key: str) -> None:
    await put_setting(db, key, "")


async def public_config(db: AsyncSession) -> dict:
    """What any signed-in client may see (the panel uses it for the dialer
    header and the 911 screen)."""
    number = await _get(db, K_NUMBER) or ""
    hold = await _get(db, K_HOLD_SECS) or "2"
    try:
        hold_i = max(1, min(3, int(hold)))
    except ValueError:
        hold_i = 2
    return {
        "number": number,
        "number_pretty": pretty(number) if number else "",
        "e911_address": await _get(db, K_E911_ADDRESS) or "",
        "hold_secs": hold_i,
        "auto_show_911": (await _get(db, K_AUTO_SHOW) or "1") == "1",
        "configured": await is_configured(db),
    }


async def is_configured(db: AsyncSession) -> bool:
    for k in (K_ACCOUNT_SID, K_AUTH_TOKEN, K_API_KEY_SID, K_API_KEY_SECRET, K_TWIML_APP_SID):
        if not await get_secret(db, k):
            return False
    return bool(await _get(db, K_NUMBER))


async def admin_status(db: AsyncSession) -> dict:
    """Admin page: which secrets are set (booleans only — values never leave)."""
    out = {k: bool(await get_secret(db, k)) for k in SECRET_KEYS}
    out.update(await public_config(db))
    return out


# ---- allow-list ------------------------------------------------------------
async def allowed_numbers(db: AsyncSession) -> list[models.AllowedNumber]:
    res = await db.execute(select(models.AllowedNumber).order_by(models.AllowedNumber.name))
    return list(res.scalars())


async def is_allowed(db: AsyncSession, e164: str) -> bool:
    if e164 in EMERGENCY:
        return True
    res = await db.execute(select(models.AllowedNumber).where(models.AllowedNumber.number == e164))
    return res.scalar_one_or_none() is not None


# ---- post-911 callback window --------------------------------------------
async def open_callback_window(db: AsyncSession) -> None:
    until = datetime.now(timezone.utc) + CALLBACK_WINDOW
    await put_setting(db, K_WINDOW_UNTIL, until.isoformat())


async def callback_window_open(db: AsyncSession) -> bool:
    raw = await _get(db, K_WINDOW_UNTIL)
    if not raw:
        return False
    try:
        return datetime.fromisoformat(raw) > datetime.now(timezone.utc)
    except ValueError:
        return False


# ---- registered browser clients (who rings on inbound) ---------------------
# Identity = one per device; registered when a token is issued. Kept in
# memory: a restart just means devices re-register on their next token
# refresh (every ~50 min, or on page load).
_clients: dict[str, float] = {}
CLIENT_TTL = 2 * 3600


def register_client(identity: str) -> None:
    _clients[identity] = time.time()


def live_clients() -> list[str]:
    cutoff = time.time() - CLIENT_TTL
    for k in [k for k, t in _clients.items() if t < cutoff]:
        _clients.pop(k, None)
    return sorted(_clients)


# ---- Twilio helpers --------------------------------------------------------
async def mint_token(db: AsyncSession, identity: str) -> str:
    """Browser access token: may place calls through our TwiML App (which
    routes to /twiml/outbound where the allow-list is enforced) and may
    receive calls addressed to this identity."""
    from twilio.jwt.access_token import AccessToken
    from twilio.jwt.access_token.grants import VoiceGrant

    account = await get_secret(db, K_ACCOUNT_SID)
    key = await get_secret(db, K_API_KEY_SID)
    secret = await get_secret(db, K_API_KEY_SECRET)
    app_sid = await get_secret(db, K_TWIML_APP_SID)
    if not (account and key and secret and app_sid):
        raise RuntimeError("Twilio is not configured")
    tok = AccessToken(account, key, secret, identity=identity, ttl=TOKEN_TTL)
    tok.add_grant(VoiceGrant(outgoing_application_sid=app_sid, incoming_allow=True))
    register_client(identity)
    return tok.to_jwt()


async def verify_signature(db: AsyncSession, url: str, form: dict, signature: str | None) -> bool:
    from twilio.request_validator import RequestValidator

    token = await get_secret(db, K_AUTH_TOKEN)
    if not token or not signature:
        return False
    return RequestValidator(token).validate(url, form, signature)


async def emergency_status(db: AsyncSession) -> dict:
    """Ask Twilio whether our number has a registered emergency address.
    Read-only REST lookup (no calls are ever placed via REST)."""
    from twilio.rest import Client

    account = await get_secret(db, K_ACCOUNT_SID)
    token = await get_secret(db, K_AUTH_TOKEN)
    number = await _get(db, K_NUMBER)
    if not (account and token and number):
        return {"ok": False, "error": "Twilio account or number not set"}
    try:
        client = Client(account, token)
        nums = client.incoming_phone_numbers.list(phone_number=number, limit=1)
        if not nums:
            return {"ok": False, "error": f"{number} is not on this Twilio account"}
        n = nums[0]
        return {
            "ok": True,
            "emergency_status": getattr(n, "emergency_status", None),
            "emergency_address_status": getattr(n, "emergency_address_status", None),
            "emergency_address_sid": getattr(n, "emergency_address_sid", None),
            "voice_url": getattr(n, "voice_url", None),
        }
    except Exception as e:  # noqa: BLE001 — surface Twilio's message to the admin
        return {"ok": False, "error": str(e)[:300]}


# ---- TwiML builders --------------------------------------------------------
def twiml_dial_number(to: str, caller_id: str, status_url: str | None) -> str:
    from twilio.twiml.voice_response import Dial, VoiceResponse

    r = VoiceResponse()
    d = Dial(caller_id=caller_id, answer_on_bridge=True)
    if status_url:
        d.number(to, status_callback=status_url, status_callback_event="initiated ringing answered completed")
    else:
        d.number(to)
    r.append(d)
    return str(r)


def twiml_refuse(text: str) -> str:
    from twilio.twiml.voice_response import VoiceResponse

    r = VoiceResponse()
    r.say(text)
    r.hangup()
    return str(r)


def twiml_ring_clients(identities: list[str], caller: str) -> str:
    from twilio.twiml.voice_response import Dial, VoiceResponse

    r = VoiceResponse()
    if not identities:
        r.say("Nobody is available to answer. Please try again later.")
        r.hangup()
        return str(r)
    d = Dial(caller_id=caller, timeout=30)
    for ident in identities:
        d.client(ident)
    r.append(d)
    return str(r)


def twiml_reject() -> str:
    from twilio.twiml.voice_response import VoiceResponse

    r = VoiceResponse()
    r.reject(reason="rejected")
    return str(r)
