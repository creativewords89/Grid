#!/bin/sh
# Start everything the end-to-end tests need, on ports of their own: a fake Google, a fresh
# database, the API, the scheduler and the web app. Playwright runs this (see
# playwright.config.ts) and stops it afterwards; it can also be run by hand.
#
# Needs: PostgreSQL (E2E_DATABASE_URL, default hub:hub@localhost; the user must be allowed
# to create databases), uv, Node, and `npm ci` done in frontend/.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="$HERE/.run"
mkdir -p "$RUN"

export APP_ENV=test
export DATABASE_URL="${E2E_DATABASE_URL:-postgresql+psycopg://hub:hub@localhost:5432/hub_e2e}"
export APP_URL=http://localhost:5190
export SECRET_KEY=e2e-only-signing-key-0123456789abcdef
export GOOGLE_TOKEN_URL=http://127.0.0.1:9921/token
export GOOGLE_SHEETS_URL=http://127.0.0.1:9921/sheets
export GOOGLE_DRIVE_URL=http://127.0.0.1:9921/drive
export API_URL=http://localhost:8200

# Stop everything started here when Playwright (or Ctrl+C) stops this script.
trap 'kill 0' EXIT INT TERM

python3 "$HERE/mocks/fake_google.py" 9921 &

cd "$HERE/../backend"
PYTHONPATH=. uv run python "$HERE/reset.py" "$RUN/setup-code"
uv run uvicorn app.main:app --port 8200 > "$RUN/api.log" 2>&1 &
uv run python -m app.scheduler > "$RUN/scheduler.log" 2>&1 &

# Playwright starts testing once the web app answers, so the API must be up before it is.
tries=0
until curl -sf http://localhost:8200/api/health > /dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 120 ]; then
    echo "the API didn't start; see $RUN/api.log" >&2
    exit 1
  fi
  sleep 0.5
done

cd "$HERE/../frontend"
npx vite --port 5190 --strictPort
