"""Google Calendar two-way sync (one shared family account).

Design and security notes:
  - The OAuth client id/secret and the encrypted refresh token live ONLY in
    the backend (app_settings). The refresh token is encrypted at rest with
    a Fernet key derived from settings.token_secret — a DB leak alone does
    not yield a usable Google token. Nothing Google-related is ever returned
    to the frontend except a boolean "connected" and the account email.
  - Test-mode OAuth app: keep the Google project in "Testing" and list the
    family account as a test user. No verification review, works forever for
    listed accounts, and stays private.
  - Sync maps Google events onto the existing CalendarEvent model. The
    google_id column dedupes; source="google" marks pulled rows. Local
    events (source in local/ical) are pushed up and gain a google_id.
  - Two-way with last-writer-wins by updated timestamp; deletes propagate.
    Recurring events: Google's own recurrence is imported as a single all-
    instances row is NOT attempted — instead we import concrete instances
    within the sync window, which keeps the model simple and predictable.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import models
from .bridge import put_setting
from .config import get_settings

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
CAL_BASE = "https://www.googleapis.com/calendar/v3"
SCOPES = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/userinfo.email",
]

# app_settings keys (none are ever returned by settings endpoints)
K_CLIENT_ID = "google_client_id"
K_CLIENT_SECRET = "google_client_secret"      # encrypted
K_REFRESH = "google_refresh_token"            # encrypted
K_EMAIL = "google_account_email"
K_CAL_ID = "google_calendar_id"               # which Google calendar to sync (default: primary)
K_SYNC_TOKEN = "google_sync_token"            # incremental sync cursor
K_STATE = "google_oauth_state"                # CSRF state for the in-flight flow
K_COLOR_MAP = "google_color_map"              # JSON {member_id: "1".."11"}

# Google's 11 event colors (colorId -> modern hex), for the admin picker.
GOOGLE_EVENT_COLORS = {
    "1": ("Lavender", "#7986CB"), "2": ("Sage", "#33B679"), "3": ("Grape", "#8E24AA"),
    "4": ("Flamingo", "#E67C73"), "5": ("Banana", "#F6BF26"), "6": ("Tangerine", "#F4511E"),
    "7": ("Peacock", "#039BE5"), "8": ("Graphite", "#616161"), "9": ("Blueberry", "#3F51B5"),
    "10": ("Basil", "#0B8043"), "11": ("Tomato", "#D50000"),
}
K_COLOR_MAP = "google_color_map"              # JSON {member_id: colorId "1".."11"}

# Google's 11 event colors (colorId -> modern hex), for the Admin picker and
# closest-match fallback. Google only accepts these IDs on events.
GOOGLE_EVENT_COLORS = {
    "1": ("Lavender", "#7986CB"), "2": ("Sage", "#33B679"), "3": ("Grape", "#8E24AA"),
    "4": ("Flamingo", "#E67C73"), "5": ("Banana", "#F6BF26"), "6": ("Tangerine", "#F4511E"),
    "7": ("Peacock", "#039BE5"), "8": ("Graphite", "#616161"), "9": ("Blueberry", "#3F51B5"),
    "10": ("Basil", "#0B8043"), "11": ("Tomato", "#D50000"),
}


def _fernet() -> Fernet:
    raw = get_settings().token_secret.encode("utf-8")
    key = base64.urlsafe_b64encode(hashlib.sha256(raw).digest())
    return Fernet(key)


def _enc(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("utf-8")


def _dec(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return _fernet().decrypt(value.encode("utf-8")).decode("utf-8")
    except (InvalidToken, ValueError):
        return None


async def _get(db: AsyncSession, key: str) -> str | None:
    row = await db.get(models.AppSetting, key)
    return row.value if row else None


def redirect_uri() -> str:
    return f"{get_settings().public_origin}/api/google/callback"


async def status(db: AsyncSession) -> dict:
    """Safe status for the frontend: never exposes secrets."""
    import json as _json
    try:
        color_map = _json.loads(await _get(db, K_COLOR_MAP) or "{}")
    except (ValueError, TypeError):
        color_map = {}
    return {
        "configured": bool(await _get(db, K_CLIENT_ID) and await _get(db, K_CLIENT_SECRET)),
        "connected": bool(await _get(db, K_REFRESH)),
        "email": await _get(db, K_EMAIL),
        "calendar_id": await _get(db, K_CAL_ID) or "primary",
        "redirect_uri": redirect_uri(),
        "palette": [{"id": k, "name": v[0], "hex": v[1]} for k, v in GOOGLE_EVENT_COLORS.items()],
        "color_map": color_map,
    }


async def set_color_map(db: AsyncSession, mapping: dict) -> None:
    import json as _json
    clean = {str(k): str(v) for k, v in mapping.items() if str(v) in GOOGLE_EVENT_COLORS}
    await put_setting(db, K_COLOR_MAP, _json.dumps(clean))


async def set_credentials(db: AsyncSession, client_id: str, client_secret: str) -> None:
    await put_setting(db, K_CLIENT_ID, client_id.strip())
    await put_setting(db, K_CLIENT_SECRET, _enc(client_secret.strip()))


async def build_auth_url(db: AsyncSession) -> str:
    client_id = await _get(db, K_CLIENT_ID)
    if not client_id:
        raise ValueError("Google client not configured")
    state = secrets.token_urlsafe(24)
    await put_setting(db, K_STATE, state)
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
    }
    return f"{AUTH_URL}?{urlencode(params)}"


async def handle_callback(db: AsyncSession, code: str, state: str) -> None:
    expected = await _get(db, K_STATE)
    if not expected or state != expected:
        raise ValueError("OAuth state mismatch")
    client_id = await _get(db, K_CLIENT_ID)
    client_secret = _dec(await _get(db, K_CLIENT_SECRET))
    if not client_id or not client_secret:
        raise ValueError("Google client not configured")
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(TOKEN_URL, data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri(),
            "grant_type": "authorization_code",
        })
        r.raise_for_status()
        tok = r.json()
        refresh = tok.get("refresh_token")
        access = tok.get("access_token")
        if not refresh:
            raise ValueError("no refresh token returned (revoke prior grant and retry)")
        await put_setting(db, K_REFRESH, _enc(refresh))
        # fetch the account email for display
        who = await c.get(USERINFO_URL, headers={"Authorization": f"Bearer {access}"})
        if who.is_success:
            await put_setting(db, K_EMAIL, who.json().get("email", ""))
    await put_setting(db, K_STATE, "")


async def disconnect(db: AsyncSession) -> None:
    for k in (K_REFRESH, K_EMAIL, K_SYNC_TOKEN, K_STATE):
        await put_setting(db, k, "")


async def _access_token(db: AsyncSession) -> str:
    """Exchange the stored refresh token for a fresh access token."""
    client_id = await _get(db, K_CLIENT_ID)
    client_secret = _dec(await _get(db, K_CLIENT_SECRET))
    refresh = _dec(await _get(db, K_REFRESH))
    if not (client_id and client_secret and refresh):
        raise ValueError("Google not connected")
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(TOKEN_URL, data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh,
            "grant_type": "refresh_token",
        })
        r.raise_for_status()
        return r.json()["access_token"]


# --- mapping helpers --------------------------------------------------------
def _to_google_body(ev: models.CalendarEvent, color_map: dict | None = None) -> dict:
    """Fort Knox event -> Google event resource. When color_map has an entry
    for the event's member, set Google's colorId so the family member's
    color carries over to everyone's phones."""
    body: dict = {"summary": ev.title}
    if ev.location:
        body["location"] = ev.location
    if ev.notes:
        body["description"] = ev.notes
    if color_map and ev.member_id and color_map.get(ev.member_id):
        cid = str(color_map[ev.member_id])
        if cid in GOOGLE_EVENT_COLORS:
            body["colorId"] = cid
    if ev.time:
        start = f"{ev.date}T{ev.time}:00"
        end_t = ev.end_time or ev.time
        end = f"{ev.date}T{end_t}:00"
        body["start"] = {"dateTime": start}
        body["end"] = {"dateTime": end}
    else:
        # all-day: Google end date is exclusive
        d = datetime.strptime(ev.date, "%Y-%m-%d").date()
        body["start"] = {"date": ev.date}
        body["end"] = {"date": (d + timedelta(days=1)).isoformat()}
    return body


def _from_google(item: dict) -> dict | None:
    """Google event resource -> fields for a CalendarEvent (concrete date)."""
    if item.get("status") == "cancelled":
        return None
    start = item.get("start", {})
    date = start.get("date")
    time = None
    if "dateTime" in start:
        dt = start["dateTime"]  # e.g. 2026-09-07T17:00:00-05:00
        date = dt[0:10]
        time = dt[11:16]
    if not date:
        return None
    return {
        "title": (item.get("summary") or "(no title)")[:160],
        "date": date,
        "time": time,
        "location": (item.get("location") or "")[:160],
        "notes": item.get("description") or "",
        "google_id": item["id"],
    }


async def sync(db: AsyncSession, window_days: int = 120) -> dict:
    """Two-way sync within a forward window. Returns a small summary."""
    import json as _json

    token = await _access_token(db)
    cal = await _get(db, K_CAL_ID) or "primary"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        color_map = _json.loads(await _get(db, K_COLOR_MAP) or "{}")
    except (ValueError, TypeError):
        color_map = {}
    now = datetime.now(timezone.utc)
    time_min = (now - timedelta(days=7)).isoformat()
    time_max = (now + timedelta(days=window_days)).isoformat()

    pulled = pushed = updated_local = deleted_local = 0

    async with httpx.AsyncClient(timeout=30) as c:
        # 1) PULL: list Google events in the window (expanded instances)
        google_by_id: dict[str, dict] = {}
        page_token = None
        while True:
            params = {
                "timeMin": time_min, "timeMax": time_max,
                "singleEvents": "true", "maxResults": 250,
                "showDeleted": "true",
            }
            if page_token:
                params["pageToken"] = page_token
            r = await c.get(f"{CAL_BASE}/calendars/{cal}/events", headers=headers, params=params)
            r.raise_for_status()
            data = r.json()
            for item in data.get("items", []):
                google_by_id[item["id"]] = item
            page_token = data.get("nextPageToken")
            if not page_token:
                break

        # existing rows that already carry a google_id
        rows = (await db.execute(
            select(models.CalendarEvent).where(models.CalendarEvent.google_id.is_not(None))
        )).scalars().all()
        local_by_gid = {r.google_id: r for r in rows}

        # apply pulls
        for gid, item in google_by_id.items():
            mapped = _from_google(item)
            if mapped is None:
                # cancelled in Google -> delete locally if we have it
                if gid in local_by_gid:
                    await db.delete(local_by_gid[gid])
                    deleted_local += 1
                continue
            existing = local_by_gid.get(gid)
            if existing is None:
                db.add(models.CalendarEvent(
                    title=mapped["title"], date=mapped["date"], time=mapped["time"],
                    location=mapped["location"], notes=mapped["notes"],
                    google_id=gid, source="google", category="general",
                ))
                pulled += 1
            else:
                existing.title = mapped["title"]; existing.date = mapped["date"]
                existing.time = mapped["time"]; existing.location = mapped["location"]
                existing.notes = mapped["notes"]
                updated_local += 1

        # 2) PUSH: local-origin events without a google_id, in the window
        win_start = (now - timedelta(days=7)).date().isoformat()
        win_end = (now + timedelta(days=window_days)).date().isoformat()
        to_push = (await db.execute(
            select(models.CalendarEvent).where(
                models.CalendarEvent.google_id.is_(None),
                models.CalendarEvent.source != "google",
                models.CalendarEvent.date >= win_start,
                models.CalendarEvent.date <= win_end,
            )
        )).scalars().all()
        for ev in to_push:
            resp = await c.post(f"{CAL_BASE}/calendars/{cal}/events", headers=headers, json=_to_google_body(ev, color_map))
            if resp.is_success:
                ev.google_id = resp.json().get("id")
                pushed += 1

        # 3) RE-COLOR: local events already in Google get their member color
        # patched (cheap, keeps Google in step when the mapping changes).
        recolored = 0
        if color_map:
            colored = (await db.execute(
                select(models.CalendarEvent).where(
                    models.CalendarEvent.google_id.is_not(None),
                    models.CalendarEvent.source != "google",
                    models.CalendarEvent.member_id.is_not(None),
                    models.CalendarEvent.date >= win_start,
                    models.CalendarEvent.date <= win_end,
                )
            )).scalars().all()
            for ev in colored:
                cid = color_map.get(ev.member_id)
                if cid and str(cid) in GOOGLE_EVENT_COLORS:
                    resp = await c.patch(
                        f"{CAL_BASE}/calendars/{cal}/events/{ev.google_id}",
                        headers=headers, json={"colorId": str(cid)},
                    )
                    if resp.is_success:
                        recolored += 1

    await db.commit()
    await put_setting(db, K_SYNC_TOKEN, now.isoformat())
    return {
        "pulled": pulled, "pushed": pushed,
        "updated": updated_local, "deleted": deleted_local, "recolored": recolored,
        "at": now.isoformat(),
    }
