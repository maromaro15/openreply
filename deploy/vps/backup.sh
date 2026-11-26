#!/usr/bin/env bash
# Daily Postgres backup for the OpenReply VPS stack.
#
# Writes a custom-format dump (restorable with pg_restore) and keeps the newest
# BACKUP_KEEP files. Safe to run twice: a dump never overwrites another one and
# a failed dump leaves no partial file behind.
#
# Cron example (as the user that can run docker), 03:15 every day:
#   15 3 * * * /opt/openreply/deploy/vps/backup.sh >> /var/log/openreply-backup.log 2>&1
#
# Settings (environment, or deploy/vps/.env):
#   BACKUP_DIR         where dumps go          (default: ./backups next to this script)
#   BACKUP_KEEP        how many dumps to keep  (default: 14)
#   BACKUP_UPLOAD_CMD  optional command run with the new dump path as $1,
#                      e.g.  rclone copyto "$1" remote:openreply/$(basename "$1")
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Read only the backup settings from .env (it is not a shell file, so it is
# never sourced).
env_value() {
  local name="$1"
  [ -f .env ] || return 0
  grep -E "^${name}=" .env | tail -n 1 | cut -d= -f2- || true
}

BACKUP_DIR="${BACKUP_DIR:-$(env_value BACKUP_DIR)}"
BACKUP_DIR="${BACKUP_DIR:-$SCRIPT_DIR/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-$(env_value BACKUP_KEEP)}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_UPLOAD_CMD="${BACKUP_UPLOAD_CMD:-$(env_value BACKUP_UPLOAD_CMD)}"

case "$BACKUP_KEEP" in
  '' | *[!0-9]* | 0) echo "[backup] BACKUP_KEEP must be a positive number" >&2; exit 1 ;;
esac

mkdir -p "$BACKUP_DIR"
umask 077

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$BACKUP_DIR/openreply-$stamp.dump"
partial="$final.partial"
trap 'rm -f "$partial"' EXIT

# pg_dump runs inside the postgres container; credentials come from its own
# environment, so no password is needed here.
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$partial"

# An empty file means pg_dump failed quietly.
[ -s "$partial" ] || { echo "[backup] dump is empty" >&2; exit 1; }
mv "$partial" "$final"
echo "[backup] wrote $final ($(du -h "$final" | cut -f1))"

# Rotation: newest first, drop everything after the first BACKUP_KEEP.
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/openreply-*.dump 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while IFS= read -r old; do
  rm -f -- "$old"
  echo "[backup] removed old $old"
done

if [ -n "$BACKUP_UPLOAD_CMD" ]; then
  # A failed upload must not delete or hide the local dump, but must show up
  # in the exit code so cron mail or monitoring notices it.
  bash -c "$BACKUP_UPLOAD_CMD" _ "$final" || { echo "[backup] upload failed" >&2; exit 2; }
  echo "[backup] uploaded"
fi
