#!/usr/bin/env bash
# Back up, build, start, wait for the engine to be healthy; roll the image back on failure.
# DEPLOY_WAIT_SECONDS (default 120) is the health wait.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_env_file

wait_s=${DEPLOY_WAIT_SECONDS:-120}

# Migrations run on boot, so every deploy backs up first.
if [ -n "$(dc ps -q --status running postgres 2>/dev/null)" ]; then
  ./deploy/backup.sh
else
  echo "postgres is not running (first deploy?), skipping the pre-deploy backup"
fi

had_previous=0
if docker image inspect holidai-engine:latest >/dev/null 2>&1; then
  docker tag holidai-engine:latest holidai-engine:previous
  had_previous=1
fi

dc build engine
dc up -d

if wait_healthy engine "$wait_s"; then
  echo "deploy ok: engine is healthy"
  exit 0
fi

echo "error: engine did not become healthy within ${wait_s}s" >&2
dc logs --tail 40 engine >&2 || true
if [ "$had_previous" = 1 ]; then
  docker tag holidai-engine:previous holidai-engine:latest
  dc up -d --no-build engine || true
  echo "rolled the engine back to the previous image." >&2
else
  echo "no previous image to roll back to." >&2
fi
echo "NOTE: a migration may already have run against the database. If the old image needs the old schema," >&2
echo "restore the pre-deploy dump: ./deploy/restore.sh --yes backups/<latest holidai-*.dump>" >&2
exit 1
