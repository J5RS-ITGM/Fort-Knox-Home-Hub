"""Pydantic schemas shared by the REST API and the frontend WebSocket."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class EntityOut(BaseModel):
    entity_id: str
    domain: str
    state: str
    friendly_name: str
    attributes: dict[str, Any] = Field(default_factory=dict)
    last_changed: datetime


class ServiceCall(BaseModel):
    entity_id: str
    data: dict[str, Any] = Field(default_factory=dict)


class PlacementIn(BaseModel):
    entity_id: str
    room: str = ""
    floor: int = 1
    x: float = 0.0
    y: float = 0.0
    icon: str | None = None


class PlacementOut(PlacementIn):
    model_config = ConfigDict(from_attributes=True)
    id: str
    updated_at: datetime


class LayoutIn(BaseModel):
    layout_json: str = "{}"


class LayoutOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    panel_key: str
    layout_json: str
    updated_at: datetime


class HealthOut(BaseModel):
    status: str
    mode: str  # "mock" | "live"
    ha_connected: bool
    entity_count: int
