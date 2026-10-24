#!/bin/sh
# api:    apply migrations, then serve the API (SPEC section 13.4: migrations run on start)
# worker: run the background worker
set -eu

case "${1:-api}" in
  api)
    alembic upgrade head
    exec uvicorn --factory app.main:serve --host 0.0.0.0 --port 8000 --proxy-headers \
      --forwarded-allow-ips '*' --no-access-log
    ;;
  worker)
    exec python -m app.worker
    ;;
  *)
    exec "$@"
    ;;
esac
