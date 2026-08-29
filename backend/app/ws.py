"""Frontend WebSocket: snapshot on connect, then live state pushes.

Protocol (server → client):
  {"type": "snapshot", "connected": bool, "entities": [Entity, ...]}
  {"type": "state", "entity": Entity}
  {"type": "bridge", "connected": bool}

Client → server messages are ignored except {"type": "ping"}, which gets a
{"type": "pong"} — useful for wall panels detecting a dead link.
"""

import asyncio
import contextlib
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .ha.state import cache

log = logging.getLogger("homehub.ws")
router = APIRouter()


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    queue = cache.subscribe()
    try:
        await ws.send_text(
            json.dumps(
                {
                    "type": "snapshot",
                    "connected": cache.ha_connected,
                    "entities": [e.to_dict() for e in cache.snapshot()],
                }
            )
        )

        async def pump_out() -> None:
            while True:
                message = await queue.get()
                await ws.send_text(json.dumps(message))

        async def pump_in() -> None:
            while True:
                raw = await ws.receive_text()
                with contextlib.suppress(json.JSONDecodeError):
                    if json.loads(raw).get("type") == "ping":
                        await ws.send_text(json.dumps({"type": "pong"}))

        out_task = asyncio.create_task(pump_out())
        in_task = asyncio.create_task(pump_in())
        done, pending = await asyncio.wait({out_task, in_task}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            with contextlib.suppress(WebSocketDisconnect, asyncio.CancelledError):
                task.result()
    except WebSocketDisconnect:
        pass
    finally:
        cache.unsubscribe(queue)
