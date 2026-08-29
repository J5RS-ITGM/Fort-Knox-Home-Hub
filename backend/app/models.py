"""Database models.

Home Assistant remains the source of truth for device *state*. Postgres owns
everything HA doesn't: household users, where sensors live on the floor plan
(feeds the isometric security board), and per-panel layout configuration for
the wall tablets.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="child")  # parent | child
    pin_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    layouts: Mapped[list["PanelLayout"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class SensorPlacement(Base):
    """Position of an HA entity on the floor plan / isometric board."""

    __tablename__ = "sensor_placements"
    __table_args__ = (UniqueConstraint("entity_id", name="uq_placement_entity"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    entity_id: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    room: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    floor: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    x: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    y: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    icon: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class PanelLayout(Base):
    """Tile layout for a named panel (kitchen hub, bedroom panel, phone)."""

    __tablename__ = "panel_layouts"
    __table_args__ = (UniqueConstraint("user_id", "panel_key", name="uq_layout_user_panel"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    panel_key: Mapped[str] = mapped_column(String(64), nullable=False)  # e.g. "kitchen", "bedroom"
    layout_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped[User | None] = relationship(back_populates="layouts")
