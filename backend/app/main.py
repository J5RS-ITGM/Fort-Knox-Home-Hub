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
from .api.auth_routes import admin_router, auth_router
from .api.routes import protected as protected_router
from .api.routes import router as api_router
from .config import get_settings
from .db import Base, engine
from .ha.client import HAClient
from .ha.mock import MockHA
from .ws import router as ws_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("homehub")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()

    if settings.db_auto_create:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        log.info("Database tables ensured (%s)", settings.database_url.split("://")[0])

    bridge = MockHA() if settings.ha_mock else HAClient()
    app.state.bridge = bridge
    bridge.start()
    log.info("HA bridge started in %s mode", "mock" if settings.ha_mock else "live")

    yield

    await bridge.stop()
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
app.include_router(ws_router)
