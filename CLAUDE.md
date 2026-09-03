# CLAUDE.md — CommandCenter (HomeHub)

Local-first home control and security app for a two-story home. Read this
before changing anything.

## Non-negotiable architecture rules

1. **Home Assistant is the source of truth for device state and alarm
   decisions.** This app is a control surface and UX layer. Never implement
   alarm logic, sensor debouncing, or device-state inference here.
2. **The HA token lives only in the backend environment.** The frontend never
   talks to HA, never sees the token, and no API key of any kind goes into
   frontend code. Anthropic API calls (recipe module, future) go through a
   backend proxy.
3. **Service calls are allowlist-only.** `backend/app/api/routes.py:
   ALLOWED_SERVICES` is the single gate. Widening it requires a comment
   explaining why, and never wildcard a domain.
4. **Local-first.** No new cloud dependencies. No CDN scripts, no Google
   Fonts at build time (egress may be blocked), no external calls at runtime
   except explicitly approved ones (Twilio for panic, RainViewer for radar).
5. **Auth is mandatory.** Every new API route requires a session
   (`get_current_user`) unless it is genuinely public; admin surfaces use
   `require_admin`; meaningful actions get an `audit()` entry. Sessions are
   HttpOnly cookies — never introduce tokens in localStorage or JWTs.
6. **Never commit secrets.** `.env` is gitignored; keep it that way. Mock
   mode (`HA_MOCK=true`, the default) must always work with zero services
   and zero credentials.

## Stack

- Backend: FastAPI + async SQLAlchemy (SQLite dev / Postgres via compose),
  Alembic, HA WebSocket bridge in `app/ha/client.py`, mock in `app/ha/mock.py`.
- Frontend: Next.js (app router) + React + Tailwind v4. Live state via the
  `useHomeHub()` hook (`src/lib/useHomeHub.ts`) — one WebSocket, snapshot
  then deltas. Commands via `callService()` (`src/lib/api.ts`).
- Legacy prototype modules live in git history and upstream zips as Vite
  JSX; they get ported, not rewritten.

## The porting pattern (established with WallPanel)

When porting a prototype module (`src/components/WallPanel.jsx` is the
reference):
- Keep the UI and interaction design intact. The port swaps data plumbing,
  not design.
- Delete inline mock arrays; derive everything from `useHomeHub()` entities.
- Entity mapping helpers stay small and local (see `boardStateFor`).
- Actions go through `callService()` only.
- Missing entities render as offline (gray), never as fake-healthy.
- Server-persisted UI state (layouts, placements) loads from the backend
  with localStorage as instant/offline fallback, saves back debounced.
- Tiles that depend on unbuilt modules (weather, calendar) stay as clearly
  labeled placeholders — never fake liveness.

## Verify before claiming done

```bash
# backend (mock mode, zero services)
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8000
curl localhost:8000/api/health        # expect mock mode, 23 entities
# frontend
cd frontend && npm install && npm run build   # must pass clean
```

Interactive checks in mock mode: toggle a light via the UI, arm/disarm,
confirm a disallowed service returns 403.

## Workflow

- Work on branches, open PRs. Never push to `main` directly.
- Small, reviewable commits. The owner reviews everything; write commit
  messages that explain *why*.
- Windows dev syncs via `scripts/Sync-FromZip.ps1`; the Pi deploys via
  `scripts/deploy.sh` (pull + compose up). Don't break either.

## Roadmap context (so you pick the right next thing)

Ported: WallPanel (`/panel`). Next: SecurityBoard (uses `/api/placements`),
HomeHubDashboard (replaces the placeholder `/`), then ChoreQuest and
RecipeBuilder (each needs new Postgres tables + routes). Floor-plan SVGs
will eventually come from Sweet Home 3D exports feeding placements.
