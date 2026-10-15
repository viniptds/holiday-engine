#!/usr/bin/env bash
# Dump Postgres to ${BACKUP_DIR:-./backups}/holidai-<UTC timestamp>.dump, prune old dumps, optionally upload to R2.
# Safe for cron: 30 3 * * * cd /srv/holidai/holiday-engine && ./deploy/backup.sh >> backups/backup.log 2>&1
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_env_file

dir=$(env_value BACKUP_DIR ./backups)
keep=$(env_value BACKUP_KEEP 14)
mkdir -p "$dir"
dir=$(cd "$dir" && pwd)

name="holidai-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp="$dir/.$name.part"
trap 'rm -f "$tmp"' EXIT

dc exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$tmp"
[ -s "$tmp" ] || { echo "error: empty dump" >&2; exit 1; }
mv "$tmp" "$dir/$name"
echo "backup written: $dir/$name ($(wc -c < "$dir/$name") bytes)"

# Keep the newest $keep dumps.
ls -1t "$dir"/holidai-*.dump 2>/dev/null | tail -n +"$((keep + 1))" | while read -r old; do
  rm -f -- "$old"
  echo "pruned: $old"
done

if [ -n "$(env_value BACKUP_S3_BUCKET)" ]; then
  dc run --rm --no-deps -T -v "$dir:/backups:ro" backup-upload "/backups/$name"
else
  echo "warning: BACKUP_S3_BUCKET is not set, skipping the off-server upload" >&2
fi
