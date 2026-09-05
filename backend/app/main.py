"""HomeHub backend entrypoint.

Run in dev:   uvicorn app.main:app --reload --port 8000
Mock mode is the default (HA_MOCK=true) so the API is fully functional with
zero external services. Set HA_MOCK=false plus HA_URL/HA_TOKEN for live mode.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import models  # noqa: F401 — register models with Base.metadata
from . import allowlist
from .api.auth_routes import admin_router, auth_router, google_router, kiosk_router
from .api.family_routes import router as family_router
from .api.routes import protected as protected_router
from .api.routes import router as api_router
from .config import get_settings
from .db import Base, engine
from .bridge import manager
from .ws import router as ws_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("homehub")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()

    if settings.db_auto_create:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            # create_all only creates missing TABLES; additive columns on
            # existing tables must be ensured by hand until the deploy
            # switches to `alembic upgrade head`. Guarded + idempotent.
            def _ensure_columns(sync_conn):
                from sqlalchemy import inspect, text
                cols = {c["name"] for c in inspect(sync_conn).get_columns("users")}
                if "pin_hash" not in cols:
                    sync_conn.execute(text("ALTER TABLE users ADD COLUMN pin_hash VARCHAR(128)"))
                    log.info("Added users.pin_hash column")
                scols = {c["name"] for c in inspect(sync_conn).get_columns("sessions")}
                if "kiosk" not in scols:
                    sync_conn.execute(text("ALTER TABLE sessions ADD COLUMN kiosk BOOLEAN NOT NULL DEFAULT FALSE"))
                    log.info("Added sessions.kiosk column")
                ccols = {c["name"] for c in inspect(sync_conn).get_columns("calendar_events")}
                _cal_adds = [
                    ("end_time", "VARCHAR(5)"), ("category", "VARCHAR(24) NOT NULL DEFAULT 'general'"),
                    ("location", "VARCHAR(160) NOT NULL DEFAULT ''"), ("recur", "VARCHAR(12) NOT NULL DEFAULT 'none'"),
                    ("recur_days", "VARCHAR(20) NOT NULL DEFAULT ''"), ("recur_until", "VARCHAR(10)"),
                    ("ical_uid", "VARCHAR(255)"), ("source", "VARCHAR(24) NOT NULL DEFAULT 'local'"),
                ]
                for cname, cdef in _cal_adds + [("google_id", "VARCHAR(255)")]:
                    if cname not in ccols:
                        sync_conn.execute(text(f"ALTER TABLE calendar_events ADD COLUMN {cname} {cdef}"))
                        log.info("Added calendar_events.%s column", cname)
            await conn.run_sync(_ensure_columns)
        log.info("Database tables ensured (%s)", settings.database_url.split("://")[0])

    from .db import SessionLocal
    async with SessionLocal() as db:
        await allowlist.ensure_seeded(db)

    await manager.start()
    app.state.manager = manager

    yield

    await manager.stop()
    await engine.dispose()


app = FastAPI(title="HomeHub API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)
app.include_router(protected_router)
app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(family_router)
app.include_router(kiosk_router)
app.include_router(google_router)
app.include_router(ws_router)
