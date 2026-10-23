#!/bin/sh
# Nightly backup (SPEC section 11): a pg_dump of the database plus a tar of the uploaded
# files, kept 14 days in BACKUP_DIR and, if BACKUP_TARGET is set, copied off the server
# with rclone. Writes BACKUP_DIR/last-backup.json, which Settings -> System shows.
#
# In Docker this runs in the `backup` service (see docker-compose.yml). To run one now:
#   docker compose exec backup /ops/backup.sh
#
# Settings (environment): PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE, UPLOAD_DIR,
# BACKUP_DIR, BACKUP_KEEP_DAYS (default 14), BACKUP_TARGET (an rclone remote and path,
# e.g. b2:gridrankers-backups; configure the remote with RCLONE_CONFIG_* variables).
set -eu

BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
UPLOAD_DIR="${UPLOAD_DIR:-/data/uploads}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
TARGET="${BACKUP_TARGET:-}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DUMP="$BACKUP_DIR/db-$STAMP.dump"
FILES="$BACKUP_DIR/uploads-$STAMP.tar.gz"
STATUS="$BACKUP_DIR/last-backup.json"

mkdir -p "$BACKUP_DIR"

# JSON strings can't hold raw quotes, backslashes or newlines.
json_text() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

status() { # ok size off_server message
  tmp="$STATUS.tmp"
  printf '{"at": "%s", "ok": %s, "size_bytes": %s, "off_server": %s, "message": "%s", "files": ["%s", "%s"]}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)" "$1" "$2" "$3" "$(json_text "$4")" \
    "$(basename "$DUMP")" "$(basename "$FILES")" > "$tmp"
  mv "$tmp" "$STATUS"
}

fail() {
  echo "backup failed: $1" >&2
  rm -f "$DUMP" "$FILES"
  status false null false "$1"
  exit 1
}

echo "backup $STAMP: database"
pg_dump --format=custom --no-owner --file="$DUMP" 2>"$BACKUP_DIR/.pg_dump.err" \
  || fail "pg_dump failed: $(tail -n 3 "$BACKUP_DIR/.pg_dump.err")"
rm -f "$BACKUP_DIR/.pg_dump.err"

echo "backup $STAMP: uploaded files"
if [ -d "$UPLOAD_DIR" ]; then
  tar -czf "$FILES" -C "$UPLOAD_DIR" . || fail "the uploads couldn't be archived"
else
  fail "the uploads folder $UPLOAD_DIR doesn't exist"
fi

# Check the dump can be read back before calling it good.
pg_restore --list "$DUMP" >/dev/null 2>&1 || fail "the database dump can't be read back"

SIZE=$(( $(wc -c < "$DUMP") + $(wc -c < "$FILES") ))

echo "backup $STAMP: removing backups older than $KEEP_DAYS days"
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'uploads-*.tar.gz' \) \
  -mtime +"$KEEP_DAYS" -delete

OFF=false
MESSAGE=""
if [ -n "$TARGET" ]; then
  echo "backup $STAMP: copying to $TARGET"
  if rclone copy "$DUMP" "$TARGET" && rclone copy "$FILES" "$TARGET"; then
    OFF=true
  else
    MESSAGE="Saved on this server, but the copy to $TARGET failed."
  fi
fi

status true "$SIZE" "$OFF" "$MESSAGE"
echo "backup $STAMP: done ($SIZE bytes)"
