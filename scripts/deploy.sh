#!/usr/bin/env bash
# HomeHub deploy — run on the Pi (via Termius SSH or cron).
# Pulls latest main and rebuilds the stack. Requires the read-only deploy
# key installed in ~/.ssh and docker compose on the host.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
docker compose up -d --build
docker image prune -f
echo "Deployed $(git rev-parse --short HEAD) at $(date -Is)"
