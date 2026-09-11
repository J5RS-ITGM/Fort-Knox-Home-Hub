"""Home Assistant WebSocket bridge (live mode).

Connects to HA's websocket API with a long-lived access token, loads the full
state table, subscribes to state_changed events, and mirrors everything into
the shared StateCache. Reconnects with capped exponential backoff so a HA
restart is transparent to the app.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

import httpx
import websockets

from .state import Entity, cache

log = logging.getLogger("homehub.ha")


def _parse_entity(raw: dict[str, Any]) -> Entity:
    last_changed = raw.get("last_changed")
    try:
        ts = datetime.fromisoformat(last_changed) if last_changed else datetime.now(timezone.utc)
    except ValueError:
        ts = datetime.now(timezone.utc)
    return Entity(
        entity_id=raw["entity_id"],
        state=raw.get("state", "unknown"),
        attributes=raw.get("attributes", {}) or {},
        last_changed=ts,
    )


class HAClient:
    def __init__(self, url: str, token: str) -> None:
        self.url = url.rstrip("/")
        self.token = token
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    @property
    def ws_url(self) -> str:
        base = self.url.replace("http://", "ws://").replace("https://", "wss://")
        return f"{base}/api/websocket"

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="ha-bridge")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await cache.set_connected(False)

    async def _run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            try:
                await self._session()
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — bridge must never die
                log.warning("HA bridge disconnected: %s", exc)
            await cache.set_connected(False)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    async def _session(self) -> None:
        url = self.ws_url
        log.info("Connecting to Home Assistant at %s", url)
        async with websockets.connect(url, max_size=8 * 1024 * 1024) as ws:
            # -- auth handshake ------------------------------------------------
            hello = json.loads(await ws.recv())
            if hello.get("type") != "auth_required":
                raise RuntimeError(f"unexpected greeting: {hello}")
            await ws.send(json.dumps({"type": "auth", "access_token": self.token}))
            reply = json.loads(await ws.recv())
            if reply.get("type") != "auth_ok":
                raise RuntimeError("HA auth failed — check HA_TOKEN")

            # -- initial state table ------------------------------------------
            await ws.send(json.dumps({"id": 1, "type": "get_states"}))
            # -- subscribe to changes -----------------------------------------
            await ws.send(json.dumps({"id": 2, "type": "subscribe_events", "event_type": "state_changed"}))

            await cache.set_connected(True)

            async for message in ws:
                data = json.loads(message)
                if data.get("id") == 1 and data.get("type") == "result" and data.get("success"):
                    for raw in data.get("result", []):
                        await cache.apply(_parse_entity(raw), broadcast=False)
                    log.info("Loaded %d entities from HA", len(cache))
                elif data.get("type") == "event":
                    new_state = data.get("event", {}).get("data", {}).get("new_state")
                    if new_state:
                        await cache.apply(_parse_entity(new_state))

    async def call_service(self, domain: str, service: str, entity_id: str, data: dict[str, Any]) -> None:
        """Forward a service call to HA over its REST API."""
        payload = {"entity_id": entity_id, **data}
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{self.url}/api/services/{domain}/{service}",
                headers={"Authorization": f"Bearer {self.token}"},
                json=payload,
            )
            resp.raise_for_status()
