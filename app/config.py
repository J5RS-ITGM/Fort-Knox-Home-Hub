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

    # --- Gallery photo storage ----------------------------------------------
    # Dev default: local folder. Compose mounts a named volume here.
    photos_dir: str = "./photos"

    # --- Home Assistant bridge ---------------------------------------------
    # When ha_mock is true the backend runs a simulated house (entities that
    # mirror the real device plan) so the frontend can be built and demoed
    # before the hub is online.
    ha_mock: bool = True
    ha_url: str = "http://homeassistant.local:8123"
    ha_token: str = ""  # long-lived access token; never commit a real one

    # --- API ----------------------------------------------------------------
    # --- Auth ---
    # Secure cookies require HTTPS; keep False only for local dev over http.
    cookie_secure: bool = False
    session_ttl_days: int = 30

    cors_origins: str = "http://localhost:3000"

    # --- Public URL (for OAuth redirects) -----------------------------------
    # The externally reachable origin, e.g. https://fortknox.jwbegroup.com.
    # Used to build the Google OAuth redirect URI. Falls back to the first
    # CORS origin in dev.
    public_url: str = ""

    # --- Secret for encrypting stored third-party tokens --------------------
    # A stable random string; used to derive a Fernet key so the Google
    # refresh token is encrypted at rest in app_settings. Set this in prod
    # (.env) and never change it after tokens are stored, or they become
    # undecryptable and the family will need to reconnect Google.
    token_secret: str = "dev-insecure-change-me"

    @property
    def public_origin(self) -> str:
        if self.public_url:
            return self.public_url.rstrip("/")
        return self.cors_origin_list[0] if self.cors_origin_list else "http://localhost:3000"

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
