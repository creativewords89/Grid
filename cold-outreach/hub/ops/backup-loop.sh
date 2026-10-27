#!/bin/sh
# The `backup` service: run ops/backup.sh once a day at BACKUP_TIME (UTC, default 21:30,
# which is 03:30 in Dhaka). A failed backup is recorded in last-backup.json and tried again
# the next night; the loop itself keeps running.
set -u
AT="${BACKUP_TIME:-21:30}"
echo "backups run daily at $AT UTC into ${BACKUP_DIR:-/data/backups}"
last=""
while true; do
  today="$(date -u +%Y-%m-%d)"
  if [ "$(date -u +%H:%M)" = "$AT" ] && [ "$last" != "$today" ]; then
    last="$today"
    /ops/backup.sh || echo "backup failed; see last-backup.json"
  fi
  sleep 30
done
