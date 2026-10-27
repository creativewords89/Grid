#!/bin/sh
# api:       apply migrations, then serve the API (migrations run on every start)
# scheduler: run the scheduler (due runs, stale runs, alerts)
set -eu

case "${1:-api}" in
  api)
    alembic upgrade head
    exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips '*'
    ;;
  scheduler)
    exec python -m app.scheduler
    ;;
  *)
    exec "$@"
    ;;
esac
