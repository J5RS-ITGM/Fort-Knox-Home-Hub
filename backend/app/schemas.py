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


# -- auth --------------------------------------------------------------------
class SetupIn(BaseModel):
    username: str
    password: str
    display_name: str = ""


class LoginIn(BaseModel):
    username: str
    password: str


class ChangePassword(BaseModel):
    current_password: str
    new_password: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    username: str
    display_name: str
    role: str
    disabled: bool
    pin_set: bool = False
    kiosk: bool = False   # session is in kiosk mode (see /api/kiosk)
    created_at: datetime


class UserCreate(BaseModel):
    username: str
    password: str
    display_name: str = ""
    role: str = "member"


class UserPatch(BaseModel):
    role: str | None = None
    disabled: bool | None = None
    password: str | None = None
    display_name: str | None = None
    pin: str | None = None        # set a new arm/disarm PIN (4-8 digits)
    clear_pin: bool | None = None  # true -> remove the PIN


class AuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    ts: datetime
    username: str
    action: str
    detail: str


# -- admin config ------------------------------------------------------------
class HASettingsOut(BaseModel):
    ha_url: str
    ha_mock: bool
    token_set: bool
    mode: str  # what the bridge is actually running


class HASettingsIn(BaseModel):
    ha_url: str | None = None
    ha_mock: bool | None = None
    ha_token: str | None = None  # write-only; never echoed back


class FamilyIn(BaseModel):
    name: str
    emoji: str = "🙂"
    color: str = "#6b8afd"
    sort: int = 0
    user_id: str | None = None


class FamilyPatch(BaseModel):
    name: str | None = None
    emoji: str | None = None
    color: str | None = None
    sort: int | None = None
    user_id: str | None = None


class FamilyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    emoji: str
    color: str
    sort: int
    user_id: str | None = None



# -- admin config ------------------------------------------------------------
class AllowIn(BaseModel):
    domain: str
    service: str
    note: str = ""


class AllowOut(AllowIn):
    model_config = ConfigDict(from_attributes=True)
    id: str


class SettingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    key: str
    value: str


class SettingsIn(BaseModel):
    values: dict[str, str]

