#!/usr/bin/env bash
# Restore a pg_dump -Fc file into Postgres: ./deploy/restore.sh --yes <dump>
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

yes=0; dump=""
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    *) dump="$arg" ;;
  esac
done
# lib.sh changed the directory; resolve a relative dump path against the original one.
[ -n "$dump" ] && [ "${dump#/}" = "$dump" ] && dump="$OLDPWD/$dump"
if [ "$yes" != 1 ] || [ -z "$dump" ]; then
  echo "usage: restore.sh --yes <dump file>   (replaces the current database contents)" >&2
  exit 1
fi
[ -s "$dump" ] || { echo "error: dump not found or empty: $dump" >&2; exit 1; }
require_env_file

echo "stopping engine"
dc stop engine
dc exec -T postgres sh -c 'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$dump"
echo "restored $dump, starting engine"
dc up -d engine
wait_healthy engine "${DEPLOY_WAIT_SECONDS:-120}" || { echo "error: engine not healthy after restore" >&2; exit 1; }
echo "restore ok: engine is healthy"
