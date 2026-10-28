#!/bin/sh
# Restore a backup made by ops/backup.sh: the database and the reports. Read ops/restore.md
# first. This REPLACES the current database and reports.
#
#   /ops/restore.sh 20261023-213000            # in the backup service: see restore.md
#   /ops/restore.sh 20261023-213000 --yes      # without the question
set -eu

STAMP="${1:-}"
BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
REPORTS_DIR="${REPORTS_DIR:-/data/reports}"
DUMP="$BACKUP_DIR/hub-$STAMP.dump"
FILES="$BACKUP_DIR/reports-$STAMP.tar.gz"

if [ -z "$STAMP" ]; then
  echo "Which backup? These are available:"
  ls "$BACKUP_DIR" | sed -n 's/^hub-\(.*\)\.dump$/  \1/p'
  exit 2
fi
[ -f "$DUMP" ] || { echo "No backup $DUMP" >&2; exit 2; }

if [ "${2:-}" != "--yes" ]; then
  printf 'This replaces the database %s and the reports with the backup from %s. Type RESTORE to go on: ' "${PGDATABASE:-?}" "$STAMP"
  read -r answer
  [ "$answer" = "RESTORE" ] || { echo "Not restored."; exit 1; }
fi

echo "restoring the database from $DUMP"
pg_restore --clean --if-exists --no-owner --single-transaction --dbname="$PGDATABASE" "$DUMP"

# Backups from before reports were kept (step 11) have no reports archive.
if [ -f "$FILES" ] && [ "${SKIP_REPORTS:-}" != "1" ]; then
  echo "restoring the reports from $FILES"
  mkdir -p "$REPORTS_DIR"
  find "$REPORTS_DIR" -mindepth 1 -delete
  tar -xzf "$FILES" -C "$REPORTS_DIR"
fi

echo "restored. Restart the Hub: docker compose restart api scheduler"
