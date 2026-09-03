"""Seed the database from seed.json.

Usage:
    cp seed.example.json seed.json     # edit with the real household
    .venv/bin/python -m app.seed       # dev (sqlite)
    docker compose exec backend python -m app.seed   # on the server

Idempotent: existing usernames and placements are skipped, never
overwritten. Passwords are NOT stored in seed.json — each created user
gets a random temporary password printed ONCE to stdout; change them via
the admin portal after first login.

seed.json is gitignored on purpose: it contains your family's names.
"""

import asyncio
import json
import secrets
import sys
from pathlib import Path

from sqlalchemy import select

from . import models
from .auth import hash_password
from .db import Base, SessionLocal, engine


async def main() -> None:
    path = Path(__file__).resolve().parent.parent / "seed.json"
    if not path.exists():
        sys.exit(f"seed.json not found at {path} — copy seed.example.json and edit it first")
    data = json.loads(path.read_text())

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    created_users: list[tuple[str, str, str]] = []
    async with SessionLocal() as db:
        # -- users ------------------------------------------------------------
        for u in data.get("users", []):
            username = u["username"].strip().lower()
            exists = (
                await db.execute(select(models.User).where(models.User.username == username))
            ).scalar_one_or_none()
            if exists:
                print(f"  user {username}: exists, skipped")
                continue
            temp = secrets.token_urlsafe(9)
            db.add(
                models.User(
                    username=username,
                    display_name=u.get("display_name", username),
                    role=u.get("role", "member"),
                    password_hash=hash_password(temp),
                )
            )
            created_users.append((username, u.get("role", "member"), temp))
        await db.commit()

        # -- placements -------------------------------------------------------
        for p in data.get("placements", []):
            entity_id = p["entity_id"]
            exists = (
                await db.execute(
                    select(models.SensorPlacement).where(models.SensorPlacement.entity_id == entity_id)
                )
            ).scalar_one_or_none()
            if exists:
                print(f"  placement {entity_id}: exists, skipped")
                continue
            db.add(
                models.SensorPlacement(
                    entity_id=entity_id,
                    room=p.get("room", ""),
                    floor=int(p.get("floor", 0)),
                    x=float(p.get("x", 0)),
                    y=float(p.get("y", 0)),
                    icon=p.get("icon"),
                )
            )
            print(f"  placement {entity_id}: created")
        await db.commit()

        # -- family roster ----------------------------------------------------
        for i, f in enumerate(data.get("family", [])):
            name = f["name"].strip()
            exists = (
                await db.execute(select(models.FamilyMember).where(models.FamilyMember.name == name))
            ).scalar_one_or_none()
            if exists:
                print(f"  family {name}: exists, skipped")
                continue
            db.add(models.FamilyMember(
                name=name,
                emoji=f.get("emoji", "🙂"),
                color=f.get("color", "#6b8afd"),
                sort=int(f.get("sort", i)),
            ))
            print(f"  family {name}: created")
        await db.commit()

        # -- settings (non-secret only) ---------------------------------------
        ALLOWED = {"home_name", "latitude", "longitude", "timezone"}
        for key, value in data.get("settings", {}).items():
            if key not in ALLOWED:
                print(f"  setting {key}: skipped (not a seedable key)")
                continue
            row = await db.get(models.AppSetting, key)
            if row is None:
                db.add(models.AppSetting(key=key, value=str(value)))
            else:
                row.value = str(value)
            print(f"  setting {key} = {value}")
        await db.commit()

        db.add(models.AuditLog(username="seed", action="seed", detail=f"{len(created_users)} users created"))
        await db.commit()

    await engine.dispose()

    if created_users:
        print("\n=== TEMPORARY PASSWORDS — shown once, change after first login ===")
        for username, role, temp in created_users:
            print(f"  {username:16s} ({role:6s})  {temp}")
    print("\nSeed complete.")


if __name__ == "__main__":
    asyncio.run(main())
