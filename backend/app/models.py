"""Database models.

Home Assistant remains the source of truth for device *state*. Postgres owns
everything HA doesn't: accounts, sessions, audit trail, sensor placements
(feeds the isometric security board), and per-panel layout configuration.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean, DateTime, Float, ForeignKey, Integer, String, Text,
    UniqueConstraint, func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="member")  # admin | member
    password_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    # Optional arm/disarm PIN (bcrypt, like passwords). When set, the service
    # proxy requires it for alarm_control_panel calls made by this user.
    pin_hash: Mapped[str | None] = mapped_column(String(128), nullable=True, default=None)
    disabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    @property
    def pin_set(self) -> bool:
        return self.pin_hash is not None

    # Set per-request by auth.resolve_session from the session row.
    kiosk: bool = False

    layouts: Mapped[list["PanelLayout"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    sessions: Mapped[list["Session"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Session(Base):
    """Server-side session. The cookie carries a random token; only its
    SHA-256 lands here, so a database leak doesn't leak usable sessions."""

    __tablename__ = "sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # Kiosk MODE is a property of the session, not the user: "Enter kiosk
    # mode" (kiosk password) flips this on; "Exit" flips it off. While on,
    # admin routes + destructive family actions are refused server-side.
    kiosk: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")

    user: Mapped[User] = relationship(back_populates="sessions")


class AuditLog(Base):
    """Who did what, when. Service calls, logins, admin actions."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    username: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    detail: Mapped[str] = mapped_column(Text, nullable=False, default="")


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
    panel_key: Mapped[str] = mapped_column(String(64), nullable=False)
    layout_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped[User | None] = relationship(back_populates="layouts")


class AppSetting(Base):
    """Key/value runtime configuration (HA connection, feature flags).
    Values here override environment defaults; the HA token is stored
    server-side only and is never returned by any API."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class FamilyMember(Base):
    """Household roster (feeds Chore Quest, recipes, panel personalization).
    Separate from auth users: kids on a wall panel don't need passwords."""

    __tablename__ = "family_members"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    emoji: Mapped[str] = mapped_column(String(16), nullable=False, default="🙂")
    color: Mapped[str] = mapped_column(String(16), nullable=False, default="#6b8afd")
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ServiceAllow(Base):
    """DB-backed service allowlist: which HA services the app may forward.
    Seeded with safe defaults on first boot; admin-editable with audit."""

    __tablename__ = "service_allowlist"
    __table_args__ = (UniqueConstraint("domain", "service", name="uq_allow_domain_service"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    domain: Mapped[str] = mapped_column(String(48), nullable=False)
    service: Mapped[str] = mapped_column(String(64), nullable=False)
    note: Mapped[str] = mapped_column(String(200), nullable=False, default="")



# -- family modules (Chores / Calendar / Gallery) ------------------------------
class Chore(Base):
    """A recurring chore assigned to one family member. v1 model: every
    chore is available daily; completion is tracked per calendar date."""

    __tablename__ = "chores"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    emoji: Mapped[str] = mapped_column(String(16), nullable=False, default="⭐")
    points: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    member_id: Mapped[str] = mapped_column(ForeignKey("family_members.id", ondelete="CASCADE"), nullable=False)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ChoreCompletion(Base):
    __tablename__ = "chore_completions"
    __table_args__ = (UniqueConstraint("chore_id", "date", name="uq_chore_date"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    chore_id: Mapped[str] = mapped_column(ForeignKey("chores.id", ondelete="CASCADE"), nullable=False)
    date: Mapped[str] = mapped_column(String(10), nullable=False)  # YYYY-MM-DD (home-local)
    done_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CalendarEvent(Base):
    """Family calendar — app-owned data (HA is not involved)."""

    __tablename__ = "calendar_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    date: Mapped[str] = mapped_column(String(10), nullable=False, index=True)  # YYYY-MM-DD
    time: Mapped[str | None] = mapped_column(String(5), nullable=True)          # HH:MM or null = all-day
    member_id: Mapped[str | None] = mapped_column(ForeignKey("family_members.id", ondelete="SET NULL"), nullable=True)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Photo(Base):
    """Gallery photo. The file lives on disk under settings.photos_dir
    (a Docker volume in prod); this row is the index."""

    __tablename__ = "photos"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    filename: Mapped[str] = mapped_column(String(200), nullable=False)  # stored name: {id}.{ext}
    original: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    content_type: Mapped[str] = mapped_column(String(64), nullable=False, default="image/jpeg")
    uploaded_by: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
