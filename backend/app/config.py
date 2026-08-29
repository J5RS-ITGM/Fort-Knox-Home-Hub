"""Application settings.

All configuration comes from environment variables (or a .env file in dev).
Defaults are chosen so `uvicorn app.main:app` runs immediately in mock mode
with a local SQLite file — no Home Assistant or Postgres required.
Docker Compose overrides DATABASE_URL to Postgres and HA_MOCK to false.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Database -----------------------------------------------------------
    # Dev default: SQLite so the scaffold runs with zero services.
    # Production (compose): postgresql+asyncpg://homehub:homehub@db:5432/homehub
    database_url: str = "sqlite+aiosqlite:///./homehub.db"
    # Create tables on startup (dev convenience). In production, disable and
    # run `alembic upgrade head` instead.
    db_auto_create: bool = True

    # --- Home Assistant bridge ---------------------------------------------
    # When ha_mock is true the backend runs a simulated house (entities that
    # mirror the real device plan) so the frontend can be built and demoed
    # before the hub is online.
    ha_mock: bool = True
    ha_url: str = "http://homeassistant.local:8123"
    ha_token: str = ""  # long-lived access token; never commit a real one

    # --- API ----------------------------------------------------------------
    cors_origins: str = "http://localhost:3000"

    @property
    def ha_ws_url(self) -> str:
        base = self.ha_url.rstrip("/")
        if base.startswith("https://"):
            return "wss://" + base[len("https://"):] + "/api/websocket"
        if base.startswith("http://"):
            return "ws://" + base[len("http://"):] + "/api/websocket"
        return base + "/api/websocket"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
