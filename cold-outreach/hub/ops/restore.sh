#!/bin/sh
# Restore a backup made by ops/backup.sh. Read ops/restore.md first.
# This REPLACES the current database.
#
#   /ops/restore.sh 20261023-213000            # in the backup service: see restore.md
#   /ops/restore.sh 20261023-213000 --yes      # without the question
set -eu

STAMP="${1:-}"
BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
DUMP="$BACKUP_DIR/hub-$STAMP.dump"

if [ -z "$STAMP" ]; then
  echo "Which backup? These are available:"
  ls "$BACKUP_DIR" | sed -n 's/^hub-\(.*\)\.dump$/  \1/p'
  exit 2
fi
[ -f "$DUMP" ] || { echo "No backup $DUMP" >&2; exit 2; }

if [ "${2:-}" != "--yes" ]; then
  printf 'This replaces the database %s with the backup from %s. Type RESTORE to go on: ' "${PGDATABASE:-?}" "$STAMP"
  read -r answer
  [ "$answer" = "RESTORE" ] || { echo "Not restored."; exit 1; }
fi

echo "restoring the database from $DUMP"
pg_restore --clean --if-exists --no-owner --single-transaction --dbname="$PGDATABASE" "$DUMP"

echo "restored. Restart the Hub: docker compose restart api scheduler"
