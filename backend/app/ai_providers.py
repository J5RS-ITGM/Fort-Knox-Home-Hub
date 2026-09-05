"""AI providers: encrypted key vault + schedule-photo extraction.

Keys are stored encrypted at rest (same Fernet vault as the Google token)
and never returned to the frontend — status endpoints expose only a
"set" boolean and the chosen model string. The backend makes the vision
call, so no API key ever reaches the browser (architecture rule #2).

Gemini is the first provider. The model string is editable in Settings
(default gemini-3.5-flash) so a Google model rotation is a settings change,
not a code change. Anthropic/OpenAI slots are reserved for later.
"""
from __future__ import annotations

import base64
import json

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from . import models
from .bridge import put_setting
from .google_cal import _dec, _enc  # reuse the same Fernet helpers

# app_settings keys (never in SETTING_KEYS, never returned by settings GET)
K_GEMINI_KEY = "ai_gemini_key"          # encrypted
K_GEMINI_MODEL = "ai_gemini_model"      # plain (not secret)
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash"

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"


async def _get(db: AsyncSession, key: str) -> str | None:
    row = await db.get(models.AppSetting, key)
    return row.value if row else None


async def status(db: AsyncSession) -> dict:
    return {
        "gemini_set": bool(await _get(db, K_GEMINI_KEY)),
        "gemini_model": (await _get(db, K_GEMINI_MODEL)) or DEFAULT_GEMINI_MODEL,
    }


async def set_gemini(db: AsyncSession, key: str | None, model: str | None) -> None:
    if key:
        await put_setting(db, K_GEMINI_KEY, _enc(key.strip()))
    if model is not None:
        await put_setting(db, K_GEMINI_MODEL, model.strip() or DEFAULT_GEMINI_MODEL)


async def clear_gemini(db: AsyncSession) -> None:
    await put_setting(db, K_GEMINI_KEY, "")


async def list_gemini_models(db: AsyncSession) -> list[str]:
    """Ask Google which models this key can use (for the settings dropdown)."""
    key = _dec(await _get(db, K_GEMINI_KEY))
    if not key:
        raise ValueError("no Gemini key set")
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(f"{GEMINI_BASE}/models", params={"key": key})
        r.raise_for_status()
        data = r.json()
    out = []
    for m in data.get("models", []):
        name = m.get("name", "").replace("models/", "")
        methods = m.get("supportedGenerationMethods", [])
        if "generateContent" in methods and "gemini" in name:
            out.append(name)
    return sorted(out)


_SCHEDULE_PROMPT = """You are reading a photo of a schedule (school calendar, sports \
schedule, activity flyer, or similar). Extract every dated event you can find.

Return ONLY a JSON array, no prose, no markdown fences. Each item:
{
  "title": "short event name (include opponent for games, e.g. 'vs Tigers')",
  "date": "YYYY-MM-DD",
  "time": "HH:MM in 24h, or null if all-day / not shown",
  "location": "place if shown, else empty string",
  "category": "one of: school, sports, activity, appointment, general"
}

Rules:
- Infer the year from context; if no year is visible, use the current year %(year)s.
- Convert times like '6pm' to '18:00', '9:30 AM' to '09:30'.
- For sports, put the opponent in the title (e.g. 'vs Warriors', '@ Eagles').
- Skip anything that isn't a real dated event (headers, notes, legends).
- If you cannot find any events, return [].
"""


async def extract_schedule(db: AsyncSession, image_bytes: bytes, mime: str) -> list[dict]:
    """Send the photo to Gemini, get back a list of candidate events.

    Returns raw candidates (unsaved) for the review screen. Each has
    title/date/time/location/category; the caller assigns member + confirms.
    """
    from datetime import datetime

    key = _dec(await _get(db, K_GEMINI_KEY))
    if not key:
        raise ValueError("no Gemini key set — add one in Admin → Settings")
    model = (await _get(db, K_GEMINI_MODEL)) or DEFAULT_GEMINI_MODEL
    prompt = _SCHEDULE_PROMPT % {"year": datetime.now().year}

    body = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {"inline_data": {"mime_type": mime, "data": base64.b64encode(image_bytes).decode("ascii")}},
            ]
        }],
        "generationConfig": {"temperature": 0, "response_mime_type": "application/json"},
    }
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            f"{GEMINI_BASE}/models/{model}:generateContent",
            params={"key": key}, json=body,
        )
        if r.status_code == 400 and "API_KEY" in r.text:
            raise ValueError("Gemini rejected the API key")
        r.raise_for_status()
        data = r.json()

    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        raise ValueError("Gemini returned no readable content")

    # response_mime_type=json should give clean JSON, but strip fences defensively
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1].lstrip("json").strip() if "```" in text[3:] else text.strip("`")
    try:
        items = json.loads(text)
    except json.JSONDecodeError:
        raise ValueError("could not parse the schedule — try a clearer photo")
    if not isinstance(items, list):
        return []

    valid_cats = {"school", "sports", "activity", "appointment", "general"}
    out: list[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        date = str(it.get("date", "")).strip()
        title = str(it.get("title", "")).strip()
        if len(date) != 10 or not title:
            continue
        cat = str(it.get("category", "general")).strip().lower()
        out.append({
            "title": title[:160],
            "date": date,
            "time": (str(it["time"])[:5] if it.get("time") else None),
            "location": str(it.get("location", ""))[:160],
            "category": cat if cat in valid_cats else "general",
        })
    return out
