# HomeHub

Local-first home control and security app. Home Assistant owns device state and alarm decisions; HomeHub owns the family-facing UX, cross-cutting logic, and non-device data. Nothing in this stack requires the internet.

## Architecture

```
Home Assistant  <--ws/rest-->  FastAPI backend  <--ws/rest-->  Next.js frontend
 (source of truth)              - entity cache                  - dashboard
                                - allowlisted service proxy     - wall panels (next)
                                - Postgres: placements,         - security board (next)
                                  users, panel layouts
```

Key security properties:
- The HA long-lived token lives only in the backend environment. The browser never talks to HA.
- The backend exposes an explicit service allowlist (`app/api/routes.py: ALLOWED_SERVICES`). Anything not listed is rejected with 403 — the dashboard is a control surface, not a raw HA console.
- Frontend WebSocket carries state only; commands go through the audited REST path.

## Dev quickstart (no services needed)

Backend (mock mode is the default — simulates the real device roster):

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev   # http://localhost:3000
```

The dashboard is fully interactive in mock mode: toggle lights, lock/unlock, arm/disarm, and watch simulated motion/climate/power drift arrive live.

## Going live against HA

1. In HA: create a long-lived access token (user profile → Security).
2. `cp backend/.env.example backend/.env`, set `HA_MOCK=false`, `HA_URL`, `HA_TOKEN`.
3. Restart the backend. The bridge loads all states, subscribes to `state_changed`, and reconnects with capped backoff through HA restarts.

## Docker / Postgres

```bash
cp .env.example .env   # set POSTGRES_PASSWORD at minimum
docker compose up --build
```

Compose runs Postgres 17, the backend on :8000, and the frontend on :3000. `DB_AUTO_CREATE=true` creates tables on boot; once the schema settles, flip it off and use migrations:

```bash
cd backend
DATABASE_URL=postgresql+asyncpg://... .venv/bin/alembic upgrade head
```

## Layout

```
backend/
  app/main.py        app factory + lifespan (starts the HA bridge)
  app/config.py      env-driven settings
  app/ha/client.py   live HA websocket bridge (auth, get_states, subscribe, backoff)
  app/ha/mock.py     simulated house matching the real BOM (Zooz, Schlage, ZEN15, WLED…)
  app/ha/state.py    process-wide entity cache + pub/sub
  app/ws.py          frontend websocket (snapshot + live pushes + ping/pong)
  app/api/routes.py  REST: health, entities, allowlisted services, placements, layouts
  app/models.py      users, sensor_placements (security board), panel_layouts
  alembic/           migrations (0001 initial)
frontend/
  src/lib/api.ts         types + REST client
  src/lib/useHomeHub.ts  websocket hook (snapshot, live state, reconnect)
  src/app/page.tsx       dashboard: status rail, alarm chip, grouped entity grid
docker-compose.yml   db + backend + frontend
```

## Verified in this build

- `GET /api/health` → mock mode, 23 entities, bridge connected
- `POST /api/services/light/turn_on` mutates state; disallowed services → 403
- `PUT /api/placements/{entity_id}` upserts and persists
- WebSocket: snapshot → ping/pong → live state pushes
- `next build` passes clean (Next 15.5, React 19, Tailwind 4)

## Auth & PWA

- Session auth: bcrypt passwords, opaque tokens (SHA-256 at rest) in
  HttpOnly/Secure/SameSite=Lax cookies. Logout and disable revoke instantly.
- First run: visiting the app offers admin creation once (`/api/auth/setup`
  seals after the first user).
- Roles: `admin` (user management + audit log at `/admin`) and `member`.
- Everything but `/api/health` and auth endpoints requires a session; the
  WebSocket validates the cookie before accepting.
- Audit log records logins, failures, service calls, and admin actions.
- PWA: installable (manifest + icons); the service worker caches only the
  static shell — never `/api` or `/ws`, because stale device state shown as
  fresh is worse than an offline banner.

## Deploying on a shared VPS (Vultr)

The stack binds to 127.0.0.1:8100 (API) and 127.0.0.1:3100 (app) so it
coexists with other apps behind the host reverse proxy:

```bash
git clone git@github.com:J5RS-ITGM/CommandCenter.git && cd CommandCenter
cp .env.example .env    # set POSTGRES_PASSWORD; keep COOKIE_SECURE=true
docker compose up -d --build
```

Then install `deploy/nginx-homehub.conf.example` (or the Caddyfile block)
for your domain — it routes `/` to the app and `/api` + `/ws` to the API on
one origin, which is what makes the cookie auth work with zero CORS.

**Reaching HA from the VPS:** point `HA_URL` across a WireGuard or
Tailscale tunnel to your home network. Never port-forward HA to the
internet. Until the tunnel exists, `HA_MOCK=true` runs the full app with
simulated devices.

## Next up

- HomeHubDashboard port (replaces the current `/`), then Chore Quest +
  recipes modules on new Postgres tables
