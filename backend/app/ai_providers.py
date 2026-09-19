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


_RECIPE_PROMPT = """You are reading a photo of a recipe (cookbook page, recipe card, \
magazine clipping, handwritten card, or a screenshot). Extract ONE recipe.

Return ONLY a JSON object, no prose, no markdown fences:
{
  "title": "recipe name",
  "category": "one short word/phrase, e.g. Dinner, Dessert, Soup, Grill (empty if unclear)",
  "servings": "e.g. '4' or '6-8' (empty if not shown)",
  "prep_time": "total/prep time as shown, e.g. '45 min' (empty if not shown)",
  "ingredients": ["one ingredient per array item, keep quantities, e.g. '2 cups flour'"],
  "steps": ["one step per array item, in order, without leading numbers"],
  "notes": "yield/temperature notes, tips, or source attribution (empty if none)"
}

Rules:
- Keep the recipe's own wording; fix obvious OCR garbles only.
- Merge wrapped lines: an ingredient or step split across lines is ONE item.
- Strip step numbers and bullet characters — ordering is the array order.
- If the photo shows multiple recipes, extract the most prominent one and \
mention the others in "notes".
- If no recipe is readable, return {"title": ""}.
"""


async def extract_recipe(db: AsyncSession, image_bytes: bytes, mime: str) -> dict:
    """Send a recipe photo to Gemini, get back one parsed recipe.

    Returns an UNSAVED candidate shaped like RecipeIn (ingredients/steps as
    newline-joined strings) for the review/edit screen; the caller saves it
    through the normal POST /api/recipes after the user confirms.
    """
    key = _dec(await _get(db, K_GEMINI_KEY))
    if not key:
        raise ValueError("no Gemini key set — add one in Admin → Settings")
    model = (await _get(db, K_GEMINI_MODEL)) or DEFAULT_GEMINI_MODEL

    body = {
        "contents": [{
            "parts": [
                {"text": _RECIPE_PROMPT},
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

    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1].lstrip("json").strip() if "```" in text[3:] else text.strip("`")
    try:
        it = json.loads(text)
    except json.JSONDecodeError:
        raise ValueError("could not parse the recipe — try a clearer photo")
    if not isinstance(it, dict) or not str(it.get("title", "")).strip():
        raise ValueError("no recipe found in that photo — try a closer, clearer shot")

    def _lines(v) -> str:
        if isinstance(v, list):
            return "\n".join(str(x).strip() for x in v if str(x).strip())
        return str(v or "").strip()

    return {
        "title": str(it.get("title", "")).strip()[:160],
        "category": str(it.get("category", "")).strip()[:40],
        "servings": str(it.get("servings", "")).strip()[:40],
        "prep_time": str(it.get("prep_time", "")).strip()[:40],
        "ingredients": _lines(it.get("ingredients"))[:8000],
        "steps": _lines(it.get("steps"))[:16000],
        "notes": _lines(it.get("notes"))[:4000],
    }


_MAINT_PROMPT = """You are reading a photo related to a HOME MAINTENANCE task \
(an appliance/equipment manual page, a maintenance schedule, a sticker on a \
unit, a handwritten note, or a how-to). Turn it into ONE clear maintenance \
task with an ordered how-to.

Return ONLY a JSON object, no prose, no markdown fences:
{
  "title": "short task name, e.g. 'Mr Cool Mini Split Service'",
  "category": "one of: HVAC, Plumbing, Electrical, Exterior, Appliance, Vehicle, Lawn, Safety, General",
  "equipment": "the specific unit/model if shown, e.g. 'Mr Cool DIY 24k' (empty if none)",
  "steps": ["one action per array item, in order, imperative voice, no leading numbers"],
  "supplies": ["consumables/tools needed, one per item, e.g. '16x25x1 MERV 11 filter' (empty array if none)"],
  "suggested_frequency": "one of: monthly, quarterly, biannual, annual (best guess from the material, else 'annual')",
  "notes": "torque specs, cautions, part numbers, or source (empty if none)"
}

Rules:
- Keep the source's own wording where it matters (part numbers, measurements); fix obvious OCR garbles only.
- Merge wrapped lines: a step or supply split across lines is ONE item.
- Strip step numbers and bullet characters — ordering is the array order.
- If the photo shows a schedule with several intervals, capture the steps for the most prominent task and put the others in "notes".
- If nothing maintenance-related is readable, return {"title": ""}.
"""


async def extract_maintenance(db: AsyncSession, image_bytes: bytes, mime: str) -> dict:
    """Send a maintenance-related photo to Gemini, get back one parsed task.

    Returns an UNSAVED candidate (steps/supplies as newline-joined strings,
    plus a suggested frequency) for the review/edit screen; the caller saves
    it through POST /api/maintenance after the user confirms.
    """
    key = _dec(await _get(db, K_GEMINI_KEY))
    if not key:
        raise ValueError("no Gemini key set — add one in Admin → Settings")
    model = (await _get(db, K_GEMINI_MODEL)) or DEFAULT_GEMINI_MODEL

    body = {
        "contents": [{
            "parts": [
                {"text": _MAINT_PROMPT},
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

    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1].lstrip("json").strip() if "```" in text[3:] else text.strip("`")
    try:
        it = json.loads(text)
    except json.JSONDecodeError:
        raise ValueError("could not parse the maintenance task — try a clearer photo")
    if not isinstance(it, dict) or not str(it.get("title", "")).strip():
        raise ValueError("no maintenance task found in that photo — try a closer, clearer shot")

    def _mlines(v) -> str:
        if isinstance(v, list):
            return "\n".join(str(x).strip() for x in v if str(x).strip())
        return str(v or "").strip()

    freq = str(it.get("suggested_frequency", "annual")).strip().lower()
    if freq not in {"monthly", "quarterly", "biannual", "annual"}:
        freq = "annual"

    return {
        "title": str(it.get("title", "")).strip()[:160],
        "category": str(it.get("category", "")).strip()[:40],
        "equipment": str(it.get("equipment", "")).strip()[:120],
        "steps": _mlines(it.get("steps"))[:16000],
        "supplies": _mlines(it.get("supplies"))[:8000],
        "notes": _mlines(it.get("notes"))[:4000],
        "frequency": freq,
    }
