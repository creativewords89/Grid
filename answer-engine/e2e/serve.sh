#!/bin/sh
# Start everything the end-to-end tests need, on ports of their own: fake Claude, Pinecone
# and Telegram, a fresh database, the API, the worker and the web app. Playwright runs this
# (see playwright.config.ts) and stops it afterwards; it can also be run by hand.
#
# Needs: PostgreSQL (E2E_DATABASE_URL, default answers:answers@localhost; the user must be
# allowed to create databases), uv, Node, and `npm ci` done in frontend/.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="$HERE/.run"
mkdir -p "$RUN"
rm -rf "$RUN/uploads" "$RUN/backups"

export APP_ENV=test
export DATABASE_URL="${E2E_DATABASE_URL:-postgresql+psycopg://answers:answers@localhost:5432/answers_e2e}"
export APP_URL=http://localhost:5180
export UPLOAD_DIR="$RUN/uploads" BACKUP_DIR="$RUN/backups"
export SECRET_KEY=e2e-only-signing-key-0123456789abcdef
export ANTHROPIC_API_KEY=sk-ant-e2e-fake ANTHROPIC_BASE_URL=http://127.0.0.1:9919
export PINECONE_API_KEY=pc-e2e-fake PINECONE_HOST=http://127.0.0.1:9918
export TELEGRAM_BOT_TOKEN=1:e2e TELEGRAM_WEBHOOK_SECRET=e2e-webhook-secret-123
export TELEGRAM_API_URL=http://127.0.0.1:9917
export SMTP_HOST=
export API_URL=http://localhost:8100

# Stop everything started here when Playwright (or Ctrl+C) stops this script.
trap 'kill 0' EXIT INT TERM

python3 "$HERE/mocks/fake_claude.py" 9919 &
python3 "$HERE/mocks/fake_pinecone.py" 9918 &
python3 "$HERE/mocks/fake_telegram.py" 9917 &

cd "$HERE/../backend"
PYTHONPATH=. uv run python "$HERE/seed.py"
uv run uvicorn app.main:app --port 8100 > "$RUN/api.log" 2>&1 &
uv run python -m app.worker > "$RUN/worker.log" 2>&1 &

# Playwright starts testing once the web app answers, so the API must be up before it is.
tries=0
until curl -sf http://localhost:8100/api/health > /dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 120 ]; then
    echo "the API didn't start; see $RUN/api.log" >&2
    exit 1
  fi
  sleep 0.5
done

cd "$HERE/../frontend"
npx vite --port 5180 --strictPort
