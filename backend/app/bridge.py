"""Bridge lifecycle + runtime HA configuration.

Effective config = app_settings rows (set via the admin panel) overriding
environment defaults. The token lives in the DB or env, is used only here,
and is never serialized by any API response.
"""

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import models
from .config import get_settings
from .db import SessionLocal
from .ha.client import HAClient
from .ha.mock import MockHA

log = logging.getLogger("homehub.bridge")

_KEYS = ("ha_mock", "ha_url", "ha_token")


async def get_setting(db: AsyncSession, key: str) -> str | None:
    row = await db.get(models.AppSetting, key)
    return row.value if row else None


async def put_setting(db: AsyncSession, key: str, value: str) -> None:
    row = await db.get(models.AppSetting, key)
    if row is None:
        db.add(models.AppSetting(key=key, value=value))
    else:
        row.value = value
    await db.commit()


async def effective_ha_config(db: AsyncSession) -> dict:
    env = get_settings()
    rows = {
        r.key: r.value
        for r in (await db.execute(select(models.AppSetting).where(models.AppSetting.key.in_(_KEYS)))).scalars()
    }
    mock_raw = rows.get("ha_mock")
    token = rows.get("ha_token") or env.ha_token
    return {
        "mock": env.ha_mock if mock_raw is None else mock_raw == "true",
        "url": rows.get("ha_url") or env.ha_url,
        "token": token,
        "token_set": bool(token),
    }


class BridgeManager:
    """Owns the running bridge; supports hot restart with fresh config."""

    def __init__(self) -> None:
        self.bridge: HAClient | MockHA | None = None
        self.mode: str = "mock"

    async def start(self) -> None:
        async with SessionLocal() as db:
            cfg = await effective_ha_config(db)
        if cfg["mock"] or not cfg["token"]:
            if not cfg["mock"] and not cfg["token"]:
                log.warning("Live mode requested but no HA token configured; starting mock")
            self.bridge = MockHA()
            self.mode = "mock"
        else:
            self.bridge = HAClient(cfg["url"], cfg["token"])
            self.mode = "live"
        self.bridge.start()
        log.info("HA bridge started in %s mode", self.mode)

    async def stop(self) -> None:
        if self.bridge:
            await self.bridge.stop()
            self.bridge = None

    async def restart(self) -> str:
        await self.stop()
        await self.start()
        return self.mode


manager = BridgeManager()
