#!/usr/bin/env bash
# Shared helpers, sourced by the other deploy scripts. Runs from the repo root, wherever it is called from.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENV_FILE=".env.production"
COMPOSE_ARGS=(-f docker-compose.prod.yml)
# Optional extra compose file (used by smoke tests): DEPLOY_COMPOSE_OVERRIDE=/path/override.yml
[ -n "${DEPLOY_COMPOSE_OVERRIDE:-}" ] && COMPOSE_ARGS+=(-f "$DEPLOY_COMPOSE_OVERRIDE")
COMPOSE_ARGS+=(--env-file "$ENV_FILE")

dc() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }

require_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "error: $ENV_FILE not found (copy .env.production.example and fill it)" >&2
    exit 1
  fi
  local mode
  mode=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")
  [ "$mode" = "600" ] || echo "warning: $ENV_FILE has mode $mode, run: chmod 600 $ENV_FILE" >&2
}

# env_value NAME [DEFAULT]: reads a value from .env.production without sourcing it.
env_value() {
  local v
  v=$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  echo "${v:-${2:-}}"
}

# wait_healthy SERVICE SECONDS: 0 when healthy, 1 on unhealthy or timeout.
wait_healthy() {
  local cid status end=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$end" ]; do
    cid=$(dc ps -q "$1" 2>/dev/null || true)
    if [ -n "$cid" ]; then
      status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo none)
      [ "$status" = "healthy" ] && return 0
      [ "$status" = "unhealthy" ] && return 1
    fi
    sleep 3
  done
  return 1
}
