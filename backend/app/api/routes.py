"""REST API routes."""

import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..auth import audit, check_rate_limit, clear_failures, get_current_user, record_failure, verify_password

# Domains whose service calls require the user's PIN (when they have one).
# Locks join the alarm here: an unlock is a security action, so a stolen
# member login can't open a door without the PIN either.
PIN_GATED_DOMAINS = {"alarm_control_panel", "lock"}
ALARM_ENTITY = "alarm_control_panel.homehub"
# Panel states an app unlock stands down. NOT "arming": unlocking a door from
# the app during the exit delay means you're heading out, and cancelling the
# arm would be a surprise. NOT "disarmed": nothing to do.
ARMED_STATES = {"armed_away", "armed_home", "armed_night", "armed_vacation", "armed_custom_bypass", "pending", "triggered"}
from .. import allowlist
from ..bridge import manager
from ..config import get_settings
from ..db import get_session
from ..ha.state import cache
from ..schemas import (
    EntityOut,
    HealthOut,
    LayoutIn,
    LayoutOut,
    PlacementIn,
    PlacementOut,
    ServiceCall,
)

router = APIRouter(prefix="/api")
protected = APIRouter(prefix="/api", dependencies=[Depends(get_current_user)])



# -- health ------------------------------------------------------------------
@router.get("/health", response_model=HealthOut)
async def health() -> HealthOut:
    settings = get_settings()
    return HealthOut(
        status="ok",
        mode=manager.mode,
        ha_connected=cache.ha_connected,
        entity_count=len(cache),
    )


# -- entities ----------------------------------------------------------------
@protected.get("/entities", response_model=list[EntityOut])
async def list_entities() -> list[EntityOut]:
    return [EntityOut(**e.to_dict()) for e in cache.snapshot()]


@protected.get("/entities/{entity_id}", response_model=EntityOut)
async def get_entity(entity_id: str) -> EntityOut:
    ent = cache.get(entity_id)
    if not ent:
        raise HTTPException(404, f"unknown entity: {entity_id}")
    return EntityOut(**ent.to_dict())


# -- service calls -----------------------------------------------------------
@protected.post("/services/{domain}/{service}", status_code=202)
async def call_service(
    domain: str,
    service: str,
    body: ServiceCall,
    request: Request,
    user: models.User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    if not allowlist.is_allowed(domain, service):
        raise HTTPException(403, f"service {domain}.{service} is not exposed by this app")
    if not cache.get(body.entity_id):
        raise HTTPException(404, f"unknown entity: {body.entity_id}")

    # The PIN is an app-level field: pop it unconditionally so it can never
    # be forwarded to HA in any service payload.
    pin = body.data.pop("pin", None)

    # Arm/disarm + lock/unlock PIN gate. Enforced here (not in the UI) so the
    # API itself is protected, and the audit trail says WHO did it.
    #
    # Two modes:
    #  * Personal device (phone/tablet, logged in as a person): the PIN must
    #    be THAT person's. Users without a PIN configured are not gated.
    #  * Kiosk session (the shared wall panel): works like an alarm keypad.
    #    ANY family member's PIN is accepted, a PIN is always required, and
    #    the action is attributed to whoever's PIN it was, not the panel.
    actor = user  # who the action is logged under
    ip = request.client.host if request.client else "?"
    if domain in PIN_GATED_DOMAINS and getattr(user, "kiosk", False):
        check_rate_limit(f"pin:kiosk:{user.username}", ip)
        if not pin:
            raise HTTPException(403, "pin_required")
        rows = (await session.execute(
            select(models.User).where(models.User.pin_hash.is_not(None), models.User.disabled.is_(False))
        )).scalars().all()
        match = next((u for u in rows if verify_password(str(pin), u.pin_hash)), None)
        if match is None:
            record_failure(f"pin:kiosk:{user.username}", ip)
            await audit(session, user.username, "alarm_pin_fail", f"{service} -> {body.entity_id} (kiosk)")
            raise HTTPException(403, "pin_invalid")
        clear_failures(f"pin:kiosk:{user.username}", ip)
        actor = match
    elif domain in PIN_GATED_DOMAINS and user.pin_hash is not None:
        check_rate_limit(f"pin:{user.username}", ip)
        if not pin:
            raise HTTPException(403, "pin_required")
        if not verify_password(str(pin), user.pin_hash):
            record_failure(f"pin:{user.username}", ip)
            await audit(session, user.username, "alarm_pin_fail", f"{service} -> {body.entity_id}")
            raise HTTPException(403, "pin_invalid")
        clear_failures(f"pin:{user.username}", ip)
    via = "" if actor is user else f" (via kiosk {user.username})"

    bridge = manager.bridge
    if bridge is None:
        raise HTTPException(503, "bridge not running")
    try:
        await bridge.call_service(domain, service, body.entity_id, body.data)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"service call failed: {exc}") from exc
    await audit(session, actor.username, "service_call", f"{domain}.{service} -> {body.entity_id}{via}")

    # A PIN-verified UNLOCK from the app also disarms the alarm. Same
    # credential as a disarm (the PIN gate above already passed), so this adds
    # no exposure; it just makes "let someone in" one action instead of two.
    # HA-side RF unlocks (automations, dashboards) are NOT covered: only this
    # app path, only after the PIN. Keypad codes at the door are handled by
    # the HA automation.
    disarmed = False
    if domain == "lock" and service == "unlock":
        alarm = cache.get(ALARM_ENTITY)
        if alarm is not None and alarm.state in ARMED_STATES:
            try:
                await bridge.call_service("alarm_control_panel", "alarm_disarm", ALARM_ENTITY, {})
                disarmed = True
                await audit(session, actor.username, "service_call",
                            f"alarm_control_panel.alarm_disarm -> {ALARM_ENTITY} (with unlock of {body.entity_id}){via}")
            except Exception:  # noqa: BLE001
                # the door still unlocked; the app will show the alarm still armed
                pass
    return {"ok": True, "disarmed": disarmed}


# -- ui settings (any signed-in user) ----------------------------------------
# Non-secret, display-affecting settings for all clients (the admin-only
# settings endpoint is for editing; this one is read-only for the UI).
@protected.get("/ui-settings")
async def ui_settings(session: AsyncSession = Depends(get_session)) -> dict:
    from .auth_routes import SETTING_KEYS

    result = await session.execute(
        select(models.AppSetting).where(models.AppSetting.key.in_(SETTING_KEYS))
    )
    return {row.key: row.value for row in result.scalars()}


# -- sensor export -----------------------------------------------------------
# Spreadsheet registry of every entity the bridge sees, joined with saved
# placements. Two sheets: "Sensors" (the security/environment devices, with
# room/floor/coords — the pairing tracker) and "All entities" (raw dump for
# YAML/automation work, exact entity_ids included). Built in-memory with
# openpyxl; nothing is written to disk.
SENSOR_DOMAINS = {"binary_sensor", "lock", "siren", "climate", "valve", "switch", "light"}


@protected.get("/export/sensors.xlsx")
async def export_sensors(session: AsyncSession = Depends(get_session)) -> Response:
    from datetime import datetime as _dt
    from io import BytesIO

    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter

    result = await session.execute(select(models.SensorPlacement))
    place = {p.entity_id: p for p in result.scalars()}
    ents = sorted(cache.snapshot(), key=lambda e: (e.domain, e.entity_id))
    floor_name = {0: "Ground", 1: "Upstairs"}

    wb = Workbook()
    head_font = Font(bold=True, color="FFFFFF")
    head_fill = PatternFill("solid", fgColor="1F2937")

    def sheet(ws, headers, rows):
        ws.append(headers)
        for c in ws[1]:
            c.font = head_font
            c.fill = head_fill
        for r in rows:
            ws.append(r)
        for i, h in enumerate(headers, 1):
            width = max([len(str(h))] + [len(str(row[i - 1])) for row in rows] or [10])
            ws.column_dimensions[get_column_letter(i)].width = min(width + 2, 48)
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions

    ws1 = wb.active
    ws1.title = "Sensors"
    sensors = [e for e in ents if e.domain in SENSOR_DOMAINS]
    sheet(
        ws1,
        ["Entity ID", "Friendly Name", "Type", "Room", "Floor", "Placed", "X", "Y", "State", "Battery %", "Last Changed"],
        [
            [
                e.entity_id,
                e.friendly_name,
                str(e.attributes.get("device_class") or e.domain),
                place[e.entity_id].room if e.entity_id in place else "",
                floor_name.get(place[e.entity_id].floor, place[e.entity_id].floor) if e.entity_id in place else "",
                "yes" if e.entity_id in place else "NOT PLACED",
                round(place[e.entity_id].x, 2) if e.entity_id in place else "",
                round(place[e.entity_id].y, 2) if e.entity_id in place else "",
                e.state,
                e.attributes.get("battery", ""),
                e.last_changed.isoformat(sep=" ", timespec="seconds"),
            ]
            for e in sensors
        ],
    )

    ws2 = wb.create_sheet("All entities")
    sheet(
        ws2,
        ["Entity ID", "Friendly Name", "Domain", "Device Class", "State", "Last Changed"],
        [
            [
                e.entity_id,
                e.friendly_name,
                e.domain,
                str(e.attributes.get("device_class") or ""),
                e.state,
                e.last_changed.isoformat(sep=" ", timespec="seconds"),
            ]
            for e in ents
        ],
    )

    buf = BytesIO()
    wb.save(buf)
    fname = f"homehub-sensors-{_dt.now().strftime('%Y%m%d')}.xlsx"
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# -- weather (HA weather entity via the bridge) -------------------------------
# HA is the source of truth (architecture rule #1): current conditions come
# from the weather.* entity's live attributes in the state cache; the hourly/
# daily forecast (incl. precipitation probability) is fetched through the
# bridge with weather.get_forecasts. No direct weather-service egress from
# this app. Entity: app_settings["weather_entity"] override, else the first
# weather.* entity HA exposes. Forecasts cached 10 min per entity.
_weather_cache: dict = {"at": 0.0, "entity": "", "hourly": [], "daily": []}


def _weather_entity_pick(setting: str | None):
    if setting:
        ent = cache.get(setting)
        if ent:
            return ent
    for e in cache.snapshot():
        if e.domain == "weather":
            return e
    return None


@protected.get("/weather")
async def weather(session: AsyncSession = Depends(get_session)) -> dict:
    import time as _t
    from datetime import datetime as _dt

    row = await session.get(models.AppSetting, "weather_entity")
    ent = _weather_entity_pick(row.value.strip() if row and row.value else None)
    if ent is None:
        return {"available": False,
                "reason": "No weather entity found — add a weather integration in Home Assistant "
                          "(Met.no or NWS), or set weather_entity in Admin → Settings."}

    now = _t.monotonic()
    if (_weather_cache["entity"] != ent.entity_id) or (now - _weather_cache["at"] > 600):
        hourly: list = []
        daily: list = []
        bridge = manager.bridge
        if bridge is not None and hasattr(bridge, "get_forecasts"):
            try:
                hourly = await bridge.get_forecasts(ent.entity_id, "hourly")
            except Exception:  # noqa: BLE001 — forecast is best-effort
                hourly = []
            try:
                daily = await bridge.get_forecasts(ent.entity_id, "daily")
            except Exception:  # noqa: BLE001
                daily = []
        _weather_cache.update(at=now, entity=ent.entity_id, hourly=hourly, daily=daily)
    hourly = _weather_cache["hourly"]
    daily = _weather_cache["daily"]

    def _num(v):
        try:
            return round(float(v))
        except (TypeError, ValueError):
            return None

    a = ent.attributes
    temp = _num(a.get("temperature"))
    today = daily[0] if daily else {}
    hi = _num(today.get("temperature"))
    lo = _num(today.get("templow"))
    if hi is None and hourly:
        hi = max((x for x in (_num(f.get("temperature")) for f in hourly[:24]) if x is not None), default=None)
    if lo is None and hourly:
        lo = min((x for x in (_num(f.get("temperature")) for f in hourly[:24]) if x is not None), default=None)
    # today's rain %: the daily figure when the integration provides one,
    # else the worst hour in the next 12
    precip = _num(today.get("precipitation_probability"))
    if precip is None:
        precip = max((x for x in (_num(f.get("precipitation_probability")) for f in hourly[:12]) if x is not None),
                     default=None)

    hourly_out = []
    for f in hourly[:8]:
        try:
            when = _dt.fromisoformat(str(f.get("datetime")).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            when = None
        hourly_out.append({
            "time": when.isoformat() if when else None,
            "temp": _num(f.get("temperature")),
            "condition": str(f.get("condition") or ""),
            "precip": _num(f.get("precipitation_probability")),
        })

    return {
        "available": True,
        "entity": ent.entity_id,
        "condition": ent.state,
        "temp": temp,
        "humidity": _num(a.get("humidity")),
        "hi": hi,
        "lo": lo,
        "precip": precip,
        "hourly": hourly_out,
    }


# -- weather radar (RainViewer proxy) ----------------------------------------
# RainViewer is an explicitly approved external dependency (see CLAUDE.md).
# Proxied through the backend so clients — wall panels on default-deny
# VLANs — only ever talk to this app. No API key involved. Meta is cached
# for 60s; tiles in a small in-memory LRU (they're immutable per-timestamp).
import time as _time
from collections import OrderedDict

_radar_meta: dict = {"at": 0.0, "data": None}
_radar_tiles: OrderedDict[str, bytes] = OrderedDict()
_RADAR_TILE_CACHE = 400


async def _radar_settings(session: AsyncSession) -> tuple[float | None, float | None]:
    lat = await session.get(models.AppSetting, "latitude")
    lon = await session.get(models.AppSetting, "longitude")
    try:
        return (float(lat.value) if lat and lat.value else None,
                float(lon.value) if lon and lon.value else None)
    except ValueError:
        return None, None


@protected.get("/radar/meta")
async def radar_meta(session: AsyncSession = Depends(get_session)) -> dict:
    import httpx

    lat, lon = await _radar_settings(session)
    now = _time.monotonic()
    if _radar_meta["data"] is None or now - _radar_meta["at"] > 60:
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                r = await client.get("https://api.rainviewer.com/public/weather-maps.json")
                r.raise_for_status()
                _radar_meta.update(at=now, data=r.json())
        except Exception as exc:  # noqa: BLE001
            if _radar_meta["data"] is None:
                raise HTTPException(503, f"radar service unreachable: {exc}") from exc
    data = _radar_meta["data"]
    frames = [
        {"ts": f["time"], "path": f["path"], "nowcast": False}
        for f in data.get("radar", {}).get("past", [])
    ] + [
        {"ts": f["time"], "path": f["path"], "nowcast": True}
        for f in data.get("radar", {}).get("nowcast", [])
    ]
    return {"frames": frames, "lat": lat, "lon": lon}


_RADAR_PATH_RE = re.compile(r"^/v2/radar/[A-Za-z0-9_]+$")


@protected.get("/radar/tile/{z}/{x}/{y}")
async def radar_tile(z: int, x: int, y: int, path: str) -> Response:
    import httpx

    # `path` comes from the meta payload (e.g. "/v2/radar/1650000000" or
    # "/v2/radar/nowcast_a1b2c3"); validate strictly — this is a proxy.
    if not _RADAR_PATH_RE.match(path):
        raise HTTPException(422, "invalid radar frame path")
    if not (2 <= z <= 12):
        raise HTTPException(422, "zoom out of range")
    key = f"{path}/{z}/{x}/{y}"
    if key in _radar_tiles:
        _radar_tiles.move_to_end(key)
        return Response(_radar_tiles[key], media_type="image/png",
                        headers={"Cache-Control": "public, max-age=600"})
    # color scheme 2 (universal blue), smoothed, snow shown
    url = f"https://tilecache.rainviewer.com{path}/256/{z}/{x}/{y}/2/1_1.png"
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(url)
            r.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"radar tile fetch failed: {exc}") from exc
    _radar_tiles[key] = r.content
    while len(_radar_tiles) > _RADAR_TILE_CACHE:
        _radar_tiles.popitem(last=False)
    return Response(r.content, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=600"})


# -- sensor placements -------------------------------------------------------
@protected.get("/placements", response_model=list[PlacementOut])
async def list_placements(session: AsyncSession = Depends(get_session)) -> list[models.SensorPlacement]:
    result = await session.execute(select(models.SensorPlacement).order_by(models.SensorPlacement.entity_id))
    return list(result.scalars())


@protected.put("/placements/{entity_id}", response_model=PlacementOut)
async def upsert_placement(
    entity_id: str, body: PlacementIn, session: AsyncSession = Depends(get_session)
) -> models.SensorPlacement:
    result = await session.execute(
        select(models.SensorPlacement).where(models.SensorPlacement.entity_id == entity_id)
    )
    placement = result.scalar_one_or_none()
    if placement is None:
        placement = models.SensorPlacement(entity_id=entity_id)
        session.add(placement)
    placement.room = body.room
    placement.floor = body.floor
    placement.x = body.x
    placement.y = body.y
    placement.icon = body.icon
    await session.commit()
    await session.refresh(placement)
    return placement


@protected.delete("/placements/{entity_id}", status_code=204)
async def delete_placement(entity_id: str, session: AsyncSession = Depends(get_session)) -> None:
    result = await session.execute(
        select(models.SensorPlacement).where(models.SensorPlacement.entity_id == entity_id)
    )
    placement = result.scalar_one_or_none()
    if placement is None:
        raise HTTPException(404, "no placement for that entity")
    await session.delete(placement)
    await session.commit()


# -- panel layouts -----------------------------------------------------------
import json as _json

DEVICE_CFG_KEY = "panel_devices"

@protected.get("/device-config")
async def get_device_config(session: AsyncSession = Depends(get_session)) -> dict:
    """Shared display config for HA devices: which entities are hidden from
    the wall panel's Devices tile, and per-light icon style
    ("ceiling" | "sconce"). One record for the whole household so every
    panel and phone agrees."""
    row = (await session.execute(
        select(models.AppSetting).where(models.AppSetting.key == DEVICE_CFG_KEY)
    )).scalar_one_or_none()
    if not row or not row.value:
        return {"hidden": [], "icons": {}, "order": {}, "board": {}}
    try:
        data = _json.loads(row.value)
    except ValueError:
        return {"hidden": [], "icons": {}, "order": {}, "board": {}}
    return {"hidden": data.get("hidden", []), "icons": data.get("icons", {}),
            "order": data.get("order", {}), "board": data.get("board", {})}


@protected.put("/device-config")
async def put_device_config(body: dict, session: AsyncSession = Depends(get_session)) -> dict:
    hidden = [str(x) for x in body.get("hidden", [])][:500]
    icons = {str(k): (v if v in ("ceiling", "sconce") else "ceiling")
             for k, v in dict(body.get("icons", {})).items()}
    order = {str(k): int(v) for k, v in dict(body.get("order", {})).items()
             if isinstance(v, (int, float))}
    board_in = dict(body.get("board", {}))
    board = {}
    try:
        ls = float(board_in.get("labelScale", 1.0))
        board["labelScale"] = min(1.8, max(0.6, ls))
    except (TypeError, ValueError):
        board["labelScale"] = 1.0
    row = (await session.execute(
        select(models.AppSetting).where(models.AppSetting.key == DEVICE_CFG_KEY)
    )).scalar_one_or_none()
    if row is None:
        row = models.AppSetting(key=DEVICE_CFG_KEY)
        session.add(row)
    row.value = _json.dumps({"hidden": hidden, "icons": icons, "order": order, "board": board})
    await session.commit()
    return {"hidden": hidden, "icons": icons, "order": order, "board": board}


# Layouts are PER LOGIN: the kitchen wall panel (its own kiosk account), a
# tablet, and a phone each keep their own arrangement. A login with no
# saved layout yet falls back to the shared/legacy layout (user_id NULL)
# so existing panels keep their look until they're edited.
@protected.get("/layouts/{panel_key}", response_model=LayoutOut)
async def get_layout(
    panel_key: str,
    user: models.User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> models.PanelLayout:
    mine = (await session.execute(
        select(models.PanelLayout).where(
            models.PanelLayout.panel_key == panel_key, models.PanelLayout.user_id == user.id
        )
    )).scalar_one_or_none()
    if mine is not None:
        return mine
    shared = (await session.execute(
        select(models.PanelLayout).where(
            models.PanelLayout.panel_key == panel_key, models.PanelLayout.user_id.is_(None)
        )
    )).scalar_one_or_none()
    if shared is None:
        raise HTTPException(404, f"no layout saved for panel: {panel_key}")
    return shared


@protected.put("/layouts/{panel_key}", response_model=LayoutOut)
async def put_layout(
    panel_key: str,
    body: LayoutIn,
    user: models.User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> models.PanelLayout:
    layout = (await session.execute(
        select(models.PanelLayout).where(
            models.PanelLayout.panel_key == panel_key, models.PanelLayout.user_id == user.id
        )
    )).scalar_one_or_none()
    if layout is None:
        layout = models.PanelLayout(panel_key=panel_key, user_id=user.id)
        session.add(layout)
    layout.layout_json = body.layout_json
    await session.commit()
    await session.refresh(layout)
    return layout
