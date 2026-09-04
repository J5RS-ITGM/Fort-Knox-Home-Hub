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
from fastapi.responses import FileResponse
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
class EventIn(BaseModel):
    title: str
    date: str            # YYYY-MM-DD
    time: str | None = None  # HH:MM
    member_id: str | None = None
    notes: str = ""


@router.get("/events")
async def list_events(start: str, end: str, db: AsyncSession = Depends(get_session)) -> list[dict]:
    rows = (await db.execute(
        select(models.CalendarEvent)
        .where(models.CalendarEvent.date >= start, models.CalendarEvent.date <= end)
        .order_by(models.CalendarEvent.date, models.CalendarEvent.time)
    )).scalars().all()
    return [
        {"id": e.id, "title": e.title, "date": e.date, "time": e.time,
         "member_id": e.member_id, "notes": e.notes}
        for e in rows
    ]


@router.post("/events", status_code=201)
async def create_event(
    body: EventIn,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> dict:
    if not body.title.strip():
        raise HTTPException(422, "title required")
    e = models.CalendarEvent(title=body.title.strip(), date=body.date, time=body.time,
                             member_id=body.member_id, notes=body.notes)
    db.add(e)
    await db.commit()
    await audit(db, user.username, "event_added", f"{e.title} ({e.date})")
    return {"id": e.id}


@router.delete("/events/{event_id}", status_code=204)
async def delete_event(
    event_id: str,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> None:
    e = await db.get(models.CalendarEvent, event_id)
    if e is None:
        raise HTTPException(404, "no such event")
    await db.delete(e)
    await db.commit()
    await audit(db, user.username, "event_deleted", f"{e.title} ({e.date})")


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
