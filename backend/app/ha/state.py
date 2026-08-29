"""In-memory entity state cache.

One process-wide cache holds the latest state of every HA entity. The HA
bridge (real or mock) writes into it; REST reads snapshots from it; each
connected frontend WebSocket subscribes to an asyncio.Queue for pushes.
"""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass
class Entity:
    entity_id: str
    state: str
    attributes: dict[str, Any] = field(default_factory=dict)
    last_changed: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def domain(self) -> str:
        return self.entity_id.split(".", 1)[0]

    @property
    def friendly_name(self) -> str:
        return self.attributes.get("friendly_name", self.entity_id)

    def to_dict(self) -> dict[str, Any]:
        return {
            "entity_id": self.entity_id,
            "domain": self.domain,
            "state": self.state,
            "friendly_name": self.friendly_name,
            "attributes": self.attributes,
            "last_changed": self.last_changed.isoformat(),
        }


class StateCache:
    def __init__(self) -> None:
        self._states: dict[str, Entity] = {}
        self._subscribers: set[asyncio.Queue] = set()
        self.ha_connected: bool = False

    # -- reads ---------------------------------------------------------------
    def get(self, entity_id: str) -> Entity | None:
        return self._states.get(entity_id)

    def snapshot(self) -> list[Entity]:
        return sorted(self._states.values(), key=lambda e: e.entity_id)

    def __len__(self) -> int:
        return len(self._states)

    # -- writes --------------------------------------------------------------
    async def apply(self, entity: Entity, *, broadcast: bool = True) -> None:
        self._states[entity.entity_id] = entity
        if broadcast:
            await self._broadcast({"type": "state", "entity": entity.to_dict()})

    async def set_connected(self, connected: bool) -> None:
        if self.ha_connected != connected:
            self.ha_connected = connected
            await self._broadcast({"type": "bridge", "connected": connected})

    # -- pub/sub -------------------------------------------------------------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=512)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    async def _broadcast(self, message: dict[str, Any]) -> None:
        dead: list[asyncio.Queue] = []
        for q in self._subscribers:
            try:
                q.put_nowait(message)
            except asyncio.QueueFull:
                dead.append(q)  # slow consumer: drop it, client will reconnect
        for q in dead:
            self._subscribers.discard(q)


cache = StateCache()
