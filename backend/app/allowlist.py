"""DB-backed service allowlist with an in-memory cache.

The hot path (every service call) checks a set in memory; admin changes
rewrite the cache. First boot seeds the defaults so behavior matches the
previous hardcoded list.
"""

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import models

log = logging.getLogger("homehub.allowlist")

DEFAULTS: list[tuple[str, str, str]] = [
    ("switch", "turn_on", ""), ("switch", "turn_off", ""), ("switch", "toggle", ""),
    ("light", "turn_on", ""), ("light", "turn_off", ""), ("light", "toggle", ""),
    ("lock", "lock", ""), ("lock", "unlock", ""),
    ("valve", "open_valve", ""), ("valve", "close_valve", ""),
    ("climate", "set_temperature", ""),
    ("alarm_control_panel", "alarm_disarm", ""),
    ("alarm_control_panel", "alarm_arm_home", ""),
    ("alarm_control_panel", "alarm_arm_away", ""),
    ("alarm_control_panel", "alarm_arm_night", ""),
]

_cache: set[tuple[str, str]] = set()


def is_allowed(domain: str, service: str) -> bool:
    return (domain, service) in _cache


def snapshot() -> set[tuple[str, str]]:
    return set(_cache)


async def refresh(db: AsyncSession) -> None:
    rows = (await db.execute(select(models.ServiceAllow))).scalars().all()
    _cache.clear()
    _cache.update((r.domain, r.service) for r in rows)


async def ensure_seeded(db: AsyncSession) -> None:
    rows = (await db.execute(select(models.ServiceAllow))).scalars().all()
    existing = {(r.domain, r.service) for r in rows}
    added = 0
    for domain, service, note in DEFAULTS:
        if (domain, service) not in existing:
            db.add(models.ServiceAllow(domain=domain, service=service, note=note))
            added += 1
    if added:
        await db.commit()
        log.info("Service allowlist: added %d new default service(s)", added)
    await refresh(db)
