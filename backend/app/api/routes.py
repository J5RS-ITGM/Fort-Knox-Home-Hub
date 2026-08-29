"""REST API routes."""

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
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

# Domains and services the app is allowed to forward. Everything else is
# rejected — the dashboard is a control surface, not a raw HA console.
ALLOWED_SERVICES: dict[str, set[str]] = {
    "switch": {"turn_on", "turn_off", "toggle"},
    "light": {"turn_on", "turn_off", "toggle"},
    "lock": {"lock", "unlock"},
    "valve": {"open_valve", "close_valve"},
    "climate": {"set_temperature"},
    "alarm_control_panel": {"alarm_disarm", "alarm_arm_home", "alarm_arm_away"},
}


# -- health ------------------------------------------------------------------
@router.get("/health", response_model=HealthOut)
async def health() -> HealthOut:
    settings = get_settings()
    return HealthOut(
        status="ok",
        mode="mock" if settings.ha_mock else "live",
        ha_connected=cache.ha_connected,
        entity_count=len(cache),
    )


# -- entities ----------------------------------------------------------------
@router.get("/entities", response_model=list[EntityOut])
async def list_entities() -> list[EntityOut]:
    return [EntityOut(**e.to_dict()) for e in cache.snapshot()]


@router.get("/entities/{entity_id}", response_model=EntityOut)
async def get_entity(entity_id: str) -> EntityOut:
    ent = cache.get(entity_id)
    if not ent:
        raise HTTPException(404, f"unknown entity: {entity_id}")
    return EntityOut(**ent.to_dict())


# -- service calls -----------------------------------------------------------
@router.post("/services/{domain}/{service}", status_code=202)
async def call_service(domain: str, service: str, body: ServiceCall, request: Request) -> dict:
    if domain not in ALLOWED_SERVICES or service not in ALLOWED_SERVICES[domain]:
        raise HTTPException(403, f"service {domain}.{service} is not exposed by this app")
    if not cache.get(body.entity_id):
        raise HTTPException(404, f"unknown entity: {body.entity_id}")
    bridge = request.app.state.bridge
    try:
        await bridge.call_service(domain, service, body.entity_id, body.data)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"service call failed: {exc}") from exc
    return {"ok": True}


# -- sensor placements -------------------------------------------------------
@router.get("/placements", response_model=list[PlacementOut])
async def list_placements(session: AsyncSession = Depends(get_session)) -> list[models.SensorPlacement]:
    result = await session.execute(select(models.SensorPlacement).order_by(models.SensorPlacement.entity_id))
    return list(result.scalars())


@router.put("/placements/{entity_id}", response_model=PlacementOut)
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


# -- panel layouts -----------------------------------------------------------
@router.get("/layouts/{panel_key}", response_model=LayoutOut)
async def get_layout(panel_key: str, session: AsyncSession = Depends(get_session)) -> models.PanelLayout:
    result = await session.execute(
        select(models.PanelLayout).where(
            models.PanelLayout.panel_key == panel_key, models.PanelLayout.user_id.is_(None)
        )
    )
    layout = result.scalar_one_or_none()
    if layout is None:
        raise HTTPException(404, f"no layout saved for panel: {panel_key}")
    return layout


@router.put("/layouts/{panel_key}", response_model=LayoutOut)
async def put_layout(
    panel_key: str, body: LayoutIn, session: AsyncSession = Depends(get_session)
) -> models.PanelLayout:
    result = await session.execute(
        select(models.PanelLayout).where(
            models.PanelLayout.panel_key == panel_key, models.PanelLayout.user_id.is_(None)
        )
    )
    layout = result.scalar_one_or_none()
    if layout is None:
        layout = models.PanelLayout(panel_key=panel_key)
        session.add(layout)
    layout.layout_json = body.layout_json
    await session.commit()
    await session.refresh(layout)
    return layout
