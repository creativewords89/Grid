#!/bin/sh
# Restore a backup made by ops/backup.sh: the database dump and the uploaded files.
# Read ops/restore.md first. This REPLACES the current database and files.
#
#   ops/restore.sh 20261023-023000            # in the backup service: see restore.md
#   ops/restore.sh 20261023-023000 --yes      # without the question
set -eu

STAMP="${1:-}"
BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
UPLOAD_DIR="${UPLOAD_DIR:-/data/uploads}"
DUMP="$BACKUP_DIR/db-$STAMP.dump"
FILES="$BACKUP_DIR/uploads-$STAMP.tar.gz"

if [ -z "$STAMP" ]; then
  echo "Which backup? These are available:"
  ls "$BACKUP_DIR" | sed -n 's/^db-\(.*\)\.dump$/  \1/p'
  exit 2
fi
[ -f "$DUMP" ] || { echo "No database backup $DUMP" >&2; exit 2; }
[ -f "$FILES" ] || { echo "No files backup $FILES" >&2; exit 2; }

if [ "${2:-}" != "--yes" ]; then
  printf 'This replaces the database %s and every uploaded file with the backup from %s. Type RESTORE to go on: ' "${PGDATABASE:-?}" "$STAMP"
  read -r answer
  [ "$answer" = "RESTORE" ] || { echo "Not restored."; exit 1; }
fi

echo "restoring the database from $DUMP"
pg_restore --clean --if-exists --no-owner --single-transaction --dbname="$PGDATABASE" "$DUMP"

echo "restoring the uploaded files from $FILES"
mkdir -p "$UPLOAD_DIR"
find "$UPLOAD_DIR" -mindepth 1 -delete
tar -xzf "$FILES" -C "$UPLOAD_DIR"

echo "restored. Restart the app (docker compose restart api worker), then press"
echo "Settings -> Knowledge base -> Rebuild index so Pinecone matches the restored data."
