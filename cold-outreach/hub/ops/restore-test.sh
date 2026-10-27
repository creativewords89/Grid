#!/bin/sh
# Prove the backups can be restored, without touching the live database: make a backup,
# restore it into a scratch database, compare every table's row count, then drop the
# scratch database. Exits non-zero if anything differs.
#
#   docker compose exec backup /ops/restore-test.sh
#
# Uses the same PG* settings as backup.sh; the user must be allowed to create databases
# (the Compose database user is).
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$PGDATABASE"
SCRATCH="${SOURCE}_restore_test"
export BACKUP_DIR="${BACKUP_DIR:-/data/backups}/restore-test"
export BACKUP_TARGET=""  # never copy a test backup off the server
export PGOPTIONS="-c client_min_messages=warning"

counts() { # database -> "table rows" lines, sorted
  for table in $(psql -d "$1" -Atc "select tablename from pg_tables where schemaname = 'public' order by 1"); do
    printf '%s %s\n' "$table" "$(psql -d "$1" -Atc "select count(*) from \"$table\"")"
  done
}

cleanup() {
  psql -d "$SOURCE" -qc "drop database if exists \"$SCRATCH\"" >/dev/null 2>&1 || true
  rm -rf "$BACKUP_DIR"
}
trap cleanup EXIT

"$HERE/backup.sh" >/dev/null
STAMP="$(ls "$BACKUP_DIR" | sed -n 's/^hub-\(.*\)\.dump$/\1/p' | tail -n 1)"
counts "$SOURCE" > "$BACKUP_DIR/before.txt"

psql -d "$SOURCE" -qc "drop database if exists \"$SCRATCH\"" >/dev/null
psql -d "$SOURCE" -qc "create database \"$SCRATCH\"" >/dev/null
PGDATABASE="$SCRATCH" "$HERE/restore.sh" "$STAMP" --yes >/dev/null
counts "$SCRATCH" > "$BACKUP_DIR/after.txt"

if ! diff "$BACKUP_DIR/before.txt" "$BACKUP_DIR/after.txt" >&2; then
  echo "restore test FAILED: the restored row counts differ (above)" >&2
  exit 1
fi
tables=$(wc -l < "$BACKUP_DIR/before.txt" | tr -d ' ')
rows=$(awk '{ sum += $2 } END { print sum }' "$BACKUP_DIR/before.txt")
echo "restore test passed: $tables tables and $rows rows came back the same"
