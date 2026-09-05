"""Family module routes: Chores, Calendar, Gallery.

App-owned data (architecture rule #1: HA owns devices; the app owns
family data like chores, events, and photos). All routes require a
session; chore/roster management is admin-only, day-to-day actions
(completing a chore, adding an event, uploading a photo) are for any
signed-in family user. Meaningful actions are audited.
"""

import os
import uuid as _uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..auth import audit, get_current_user, require_admin
from ..config import get_settings
from ..db import get_session

router = APIRouter(prefix="/api", dependencies=[Depends(get_current_user)])


# -- shared: family roster (read-only for everyone; managed in Admin) ---------
@router.get("/family")
async def family_roster(db: AsyncSession = Depends(get_session)) -> list[dict]:
    result = await db.execute(select(models.FamilyMember).order_by(models.FamilyMember.sort, models.FamilyMember.name))
    return [
        {"id": m.id, "name": m.name, "emoji": m.emoji, "color": m.color, "sort": m.sort}
        for m in result.scalars()
    ]


# ============================ Chores =========================================
class ChoreIn(BaseModel):
    title: str
    emoji: str = "⭐"
    points: int = 1
    member_id: str
    sort: int = 0


class ChorePatch(BaseModel):
    title: str | None = None
    emoji: str | None = None
    points: int | None = None
    member_id: str | None = None
    sort: int | None = None


@router.get("/chores")
async def list_chores(date: str, db: AsyncSession = Depends(get_session)) -> list[dict]:
    """All chores plus whether each is done on `date` (YYYY-MM-DD)."""
    chores = (await db.execute(select(models.Chore).order_by(models.Chore.sort, models.Chore.created_at))).scalars().all()
    done_rows = (await db.execute(select(models.ChoreCompletion.chore_id).where(models.ChoreCompletion.date == date))).scalars().all()
    done = set(done_rows)
    return [
        {"id": c.id, "title": c.title, "emoji": c.emoji, "points": c.points,
         "member_id": c.member_id, "sort": c.sort, "done": c.id in done}
        for c in chores
    ]


@router.get("/chores/completions")
async def chore_completions(start: str, end: str, db: AsyncSession = Depends(get_session)) -> list[dict]:
    """Completions in [start, end] (inclusive) for points tallies."""
    rows = (await db.execute(
        select(models.ChoreCompletion).where(models.ChoreCompletion.date >= start, models.ChoreCompletion.date <= end)
    )).scalars().all()
    return [{"chore_id": r.chore_id, "date": r.date} for r in rows]


@router.post("/chores", status_code=201)
async def create_chore(
    body: ChoreIn,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> dict:
    if not body.title.strip():
        raise HTTPException(422, "title required")
    if await db.get(models.FamilyMember, body.member_id) is None:
        raise HTTPException(404, "no such family member")
    c = models.Chore(title=body.title.strip(), emoji=body.emoji, points=max(1, body.points),
                     member_id=body.member_id, sort=body.sort)
    db.add(c)
    await db.commit()
    await audit(db, admin.username, "chore_added", c.title)
    return {"id": c.id}


@router.patch("/chores/{chore_id}")
async def patch_chore(
    chore_id: str,
    body: ChorePatch,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> dict:
    c = await db.get(models.Chore, chore_id)
    if c is None:
        raise HTTPException(404, "no such chore")
    if body.title is not None:
        c.title = body.title.strip()
    if body.emoji is not None:
        c.emoji = body.emoji
    if body.points is not None:
        c.points = max(1, body.points)
    if body.member_id is not None:
        if await db.get(models.FamilyMember, body.member_id) is None:
            raise HTTPException(404, "no such family member")
        c.member_id = body.member_id
    if body.sort is not None:
        c.sort = body.sort
    await db.commit()
    await audit(db, admin.username, "chore_updated", c.title)
    return {"ok": True}


@router.delete("/chores/{chore_id}", status_code=204)
async def delete_chore(
    chore_id: str,
    admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> None:
    c = await db.get(models.Chore, chore_id)
    if c is None:
        raise HTTPException(404, "no such chore")
    await db.delete(c)
    await db.commit()
    await audit(db, admin.username, "chore_deleted", c.title)


class ToggleIn(BaseModel):
    date: str  # YYYY-MM-DD


@router.post("/chores/{chore_id}/toggle")
async def toggle_chore(
    chore_id: str,
    body: ToggleIn,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> dict:
    c = await db.get(models.Chore, chore_id)
    if c is None:
        raise HTTPException(404, "no such chore")
    existing = (await db.execute(
        select(models.ChoreCompletion).where(
            models.ChoreCompletion.chore_id == chore_id, models.ChoreCompletion.date == body.date
        )
    )).scalar_one_or_none()
    if existing:
        await db.delete(existing)
        await db.commit()
        await audit(db, user.username, "chore_undone", f"{c.title} ({body.date})")
        return {"done": False}
    db.add(models.ChoreCompletion(chore_id=chore_id, date=body.date))
    await db.commit()
    await audit(db, user.username, "chore_done", f"{c.title} ({body.date})")
    return {"done": True}


# ============================ Calendar =======================================
# Categories the UI knows about (color-coded client-side). "general" is the
# fallback for anything unrecognized or imported without a category.
CATEGORIES = ["general", "school", "sports", "activity", "appointment", "birthday", "holiday", "chore", "work"]
_WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]


class EventIn(BaseModel):
    title: str
    date: str                       # YYYY-MM-DD (start)
    time: str | None = None         # HH:MM, null = all-day
    end_time: str | None = None     # HH:MM optional
    member_id: str | None = None
    category: str = "general"
    location: str = ""
    notes: str = ""
    recur: str = "none"             # none|daily|weekly|biweekly|monthly
    recur_days: str = ""            # CSV of 0..6 (Mon..Sun) for weekly/biweekly
    recur_until: str | None = None  # YYYY-MM-DD


def _expand(ev: models.CalendarEvent, start: str, end: str) -> list[dict]:
    """Expand a (possibly recurring) event into concrete dated instances
    that fall within [start, end]. Non-recurring events yield at most one."""
    from datetime import date, timedelta

    def d(s: str) -> date:
        y, m, dd = s.split("-"); return date(int(y), int(m), int(dd))

    base = {
        "id": ev.id, "title": ev.title, "time": ev.time, "end_time": ev.end_time,
        "member_id": ev.member_id, "category": ev.category or "general",
        "location": ev.location, "notes": ev.notes, "recur": ev.recur,
        "source": ev.source,
    }
    s0, e0 = d(start), d(end)
    try:
        first = d(ev.date)
    except Exception:  # noqa: BLE001
        return []
    if ev.recur in ("none", "", None):
        return [{**base, "date": ev.date, "instance": ev.date}] if s0 <= first <= e0 else []

    until = d(ev.recur_until) if ev.recur_until else e0
    stop = min(e0, until)
    out: list[dict] = []
    if ev.recur in ("weekly", "biweekly"):
        step = 7 if ev.recur == "weekly" else 14
        days = [int(x) for x in ev.recur_days.split(",") if x.strip().isdigit()] or [first.weekday()]
        # walk weeks from the start's Monday
        wk = first - timedelta(days=first.weekday())
        while wk <= stop:
            for wd in days:
                inst = wk + timedelta(days=wd)
                if inst >= first and s0 <= inst <= stop:
                    out.append({**base, "date": inst.isoformat(), "instance": inst.isoformat()})
            wk += timedelta(days=step)
    elif ev.recur == "daily":
        cur = max(first, s0)
        while cur <= stop:
            out.append({**base, "date": cur.isoformat(), "instance": cur.isoformat()})
            cur += timedelta(days=1)
    elif ev.recur == "monthly":
        y, m = first.year, first.month
        while True:
            try:
                inst = date(y, m, first.day)
            except ValueError:
                inst = None
            if inst and inst > stop:
                break
            if inst and inst >= first and s0 <= inst <= stop:
                out.append({**base, "date": inst.isoformat(), "instance": inst.isoformat()})
            m += 1
            if m > 12:
                m = 1; y += 1
            if date(y, m, 1) > stop:
                break
    return out


@router.get("/events")
async def list_events(start: str, end: str, db: AsyncSession = Depends(get_session)) -> list[dict]:
    # Pull events whose base date is on/before the window end (recurring ones
    # may start earlier), then expand. recur_until keeps expansion bounded.
    rows = (await db.execute(
        select(models.CalendarEvent).where(models.CalendarEvent.date <= end)
    )).scalars().all()
    out: list[dict] = []
    for ev in rows:
        out.extend(_expand(ev, start, end))
    out.sort(key=lambda x: (x["date"], x["time"] or ""))
    return out


@router.post("/events", status_code=201)
async def create_event(
    body: EventIn,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> dict:
    if not body.title.strip():
        raise HTTPException(422, "title required")
    cat = body.category if body.category in CATEGORIES else "general"
    e = models.CalendarEvent(
        title=body.title.strip(), date=body.date, time=body.time, end_time=body.end_time,
        member_id=body.member_id, category=cat, location=body.location.strip(),
        notes=body.notes, recur=body.recur or "none", recur_days=body.recur_days,
        recur_until=body.recur_until, source="local",
    )
    db.add(e)
    await db.commit()
    await audit(db, user.username, "event_added", f"{e.title} ({e.date})")
    return {"id": e.id}


@router.patch("/events/{event_id}")
async def patch_event(
    event_id: str,
    body: EventIn,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> dict:
    if getattr(user, "kiosk", False):
        raise HTTPException(403, "the panel account can't edit events")
    e = await db.get(models.CalendarEvent, event_id)
    if e is None:
        raise HTTPException(404, "no such event")
    e.title = body.title.strip() or e.title
    e.date = body.date; e.time = body.time; e.end_time = body.end_time
    e.member_id = body.member_id
    e.category = body.category if body.category in CATEGORIES else "general"
    e.location = body.location.strip(); e.notes = body.notes
    e.recur = body.recur or "none"; e.recur_days = body.recur_days; e.recur_until = body.recur_until
    await db.commit()
    await audit(db, user.username, "event_updated", f"{e.title} ({e.date})")
    return {"ok": True}


@router.delete("/events/{event_id}", status_code=204)
async def delete_event(
    event_id: str,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> None:
    if getattr(user, "kiosk", False):
        raise HTTPException(403, "the panel account can't delete events")
    e = await db.get(models.CalendarEvent, event_id)
    if e is None:
        raise HTTPException(404, "no such event")
    await db.delete(e)
    await db.commit()
    await audit(db, user.username, "event_deleted", f"{e.title} ({e.date})")


@router.get("/events/categories")
async def event_categories() -> list[str]:
    return CATEGORIES


class BulkEventsIn(BaseModel):
    events: list[EventIn]


@router.post("/events/bulk", status_code=201)
async def create_events_bulk(
    body: BulkEventsIn,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> dict:
    if getattr(user, "kiosk", False):
        raise HTTPException(403, "the panel account can't add events")
    added = 0
    for ev in body.events:
        if not ev.title.strip() or len(ev.date) != 10:
            continue
        cat = ev.category if ev.category in CATEGORIES else "general"
        db.add(models.CalendarEvent(
            title=ev.title.strip(), date=ev.date, time=ev.time, end_time=ev.end_time,
            member_id=ev.member_id, category=cat, location=ev.location.strip(),
            notes=ev.notes, recur=ev.recur or "none", recur_days=ev.recur_days,
            recur_until=ev.recur_until, source="local",
        ))
        added += 1
    await db.commit()
    await audit(db, user.username, "events_bulk_added", f"{added} events")
    return {"added": added}


# -- iCal (.ics) import / export ---------------------------------------------
# Standards-based interchange (RFC 5545) — works with Google, Apple, Outlook
# without OAuth. Google Calendar live two-way sync is a separate feature.
def _ics_escape(v: str) -> str:
    return v.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


@router.get("/events/export.ics")
async def export_ics(db: AsyncSession = Depends(get_session)) -> Response:
    from datetime import datetime as _dt

    rows = (await db.execute(select(models.CalendarEvent))).scalars().all()
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fort Knox Home Hub//Calendar//EN", "CALSCALE:GREGORIAN"]
    for e in rows:
        uid = e.ical_uid or f"{e.id}@fortknox"
        dt = e.date.replace("-", "")
        lines.append("BEGIN:VEVENT")
        lines.append(f"UID:{uid}")
        lines.append(f"DTSTAMP:{_dt.utcnow().strftime('%Y%m%dT%H%M%SZ')}")
        if e.time:
            lines.append(f"DTSTART:{dt}T{e.time.replace(':', '')}00")
            if e.end_time:
                lines.append(f"DTEND:{dt}T{e.end_time.replace(':', '')}00")
        else:
            lines.append(f"DTSTART;VALUE=DATE:{dt}")
        lines.append(f"SUMMARY:{_ics_escape(e.title)}")
        if e.location:
            lines.append(f"LOCATION:{_ics_escape(e.location)}")
        if e.notes:
            lines.append(f"DESCRIPTION:{_ics_escape(e.notes)}")
        if e.category and e.category != "general":
            lines.append(f"CATEGORIES:{e.category.upper()}")
        if e.recur == "daily":
            lines.append("RRULE:FREQ=DAILY")
        elif e.recur in ("weekly", "biweekly"):
            days = [_WEEKDAYS[int(x)] for x in e.recur_days.split(",") if x.strip().isdigit()]
            rule = "RRULE:FREQ=WEEKLY" + (";INTERVAL=2" if e.recur == "biweekly" else "")
            if days:
                rule += f";BYDAY={','.join(days)}"
            lines.append(rule)
        elif e.recur == "monthly":
            lines.append("RRULE:FREQ=MONTHLY")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    body = "\r\n".join(lines) + "\r\n"
    return Response(
        content=body, media_type="text/calendar",
        headers={"Content-Disposition": 'attachment; filename="fortknox-calendar.ics"'},
    )


def _unescape(v: str) -> str:
    return v.replace("\\n", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")


@router.post("/events/import.ics")
async def import_ics(
    file: UploadFile,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> dict:
    if getattr(user, "kiosk", False):
        raise HTTPException(403, "the panel account can't import events")
    raw = (await file.read()).decode("utf-8", "ignore")
    # unfold folded lines (RFC 5545: continuation lines start with space/tab)
    unfolded: list[str] = []
    for line in raw.splitlines():
        if line[:1] in (" ", "\t") and unfolded:
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)

    added = updated = 0
    cur: dict | None = None
    for line in unfolded:
        if line.startswith("BEGIN:VEVENT"):
            cur = {}
        elif line.startswith("END:VEVENT") and cur is not None:
            if cur.get("date") and cur.get("title"):
                uid = cur.get("uid")
                existing = None
                if uid:
                    existing = (await db.execute(
                        select(models.CalendarEvent).where(models.CalendarEvent.ical_uid == uid)
                    )).scalar_one_or_none()
                if existing:
                    existing.title = cur["title"]; existing.date = cur["date"]
                    existing.time = cur.get("time"); existing.location = cur.get("location", "")
                    existing.notes = cur.get("notes", ""); existing.category = cur.get("category", "general")
                    updated += 1
                else:
                    db.add(models.CalendarEvent(
                        title=cur["title"], date=cur["date"], time=cur.get("time"),
                        location=cur.get("location", ""), notes=cur.get("notes", ""),
                        category=cur.get("category", "general"), ical_uid=uid, source="ical",
                    ))
                    added += 1
            cur = None
        elif cur is not None:
            key, _, val = line.partition(":")
            name = key.split(";")[0].upper()
            if name == "UID":
                cur["uid"] = val.strip()
            elif name == "SUMMARY":
                cur["title"] = _unescape(val.strip())[:160]
            elif name == "LOCATION":
                cur["location"] = _unescape(val.strip())[:160]
            elif name == "DESCRIPTION":
                cur["notes"] = _unescape(val.strip())
            elif name == "CATEGORIES":
                c = val.strip().lower().split(",")[0]
                cur["category"] = c if c in CATEGORIES else "general"
            elif name == "DTSTART":
                v = val.strip()
                digits = v.replace("Z", "")
                if len(digits) >= 8:
                    cur["date"] = f"{digits[0:4]}-{digits[4:6]}-{digits[6:8]}"
                    if "T" in v and len(digits) >= 13:
                        tpart = digits.split("T")[1]
                        cur["time"] = f"{tpart[0:2]}:{tpart[2:4]}"
    await db.commit()
    await audit(db, user.username, "calendar_imported", f"+{added} ~{updated} from {file.filename}")
    return {"added": added, "updated": updated}


# ============================ Gallery ========================================
_ALLOWED_IMAGE = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
_MAX_PHOTO_BYTES = 20 * 1024 * 1024


def _photos_dir() -> str:
    d = get_settings().photos_dir
    os.makedirs(d, exist_ok=True)
    return d


@router.get("/photos")
async def list_photos(db: AsyncSession = Depends(get_session)) -> list[dict]:
    rows = (await db.execute(select(models.Photo).order_by(models.Photo.created_at.desc()))).scalars().all()
    return [
        {"id": p.id, "original": p.original, "uploaded_by": p.uploaded_by,
         "created_at": p.created_at.isoformat()}
        for p in rows
    ]


@router.post("/photos", status_code=201)
async def upload_photo(
    file: UploadFile,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> dict:
    ext = _ALLOWED_IMAGE.get(file.content_type or "")
    if ext is None:
        raise HTTPException(422, "only JPEG, PNG, WebP, or GIF images")
    data = await file.read()
    if len(data) > _MAX_PHOTO_BYTES:
        raise HTTPException(413, "photo too large (20MB max)")
    pid = str(_uuid.uuid4())
    stored = f"{pid}{ext}"
    with open(os.path.join(_photos_dir(), stored), "wb") as f:
        f.write(data)
    p = models.Photo(id=pid, filename=stored, original=(file.filename or "")[:200],
                     content_type=file.content_type, uploaded_by=user.username)
    db.add(p)
    await db.commit()
    await audit(db, user.username, "photo_uploaded", p.original or stored)
    return {"id": pid}


@router.get("/photos/{photo_id}/file")
async def photo_file(photo_id: str, db: AsyncSession = Depends(get_session)) -> FileResponse:
    p = await db.get(models.Photo, photo_id)
    if p is None:
        raise HTTPException(404, "no such photo")
    path = os.path.join(_photos_dir(), p.filename)
    if not os.path.isfile(path):
        raise HTTPException(404, "photo file missing")
    return FileResponse(path, media_type=p.content_type,
                        headers={"Cache-Control": "private, max-age=86400"})


@router.delete("/photos/{photo_id}", status_code=204)
async def delete_photo(
    photo_id: str,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> None:
    if getattr(user, "kiosk", False):
        raise HTTPException(403, "the panel account can't delete photos")
    p = await db.get(models.Photo, photo_id)
    if p is None:
        raise HTTPException(404, "no such photo")
    path = os.path.join(_photos_dir(), p.filename)
    await db.delete(p)
    await db.commit()
    try:
        os.remove(path)
    except OSError:
        pass
    await audit(db, user.username, "photo_deleted", p.original or p.filename)
