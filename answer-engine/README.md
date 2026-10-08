# GridRankers Answer Engine

Answers questions from GridRankers' own documents, learns from reviewer corrections and drafts
replies for Reddit and Facebook threads. The full design is in [SPEC.md](SPEC.md).

## Run the checks on your computer

Needs Python 3.12+, [uv](https://docs.astral.sh/uv/), Node 22 and a PostgreSQL 16 server.

```sh
# Backend: a Postgres user that may create databases (tests make a throw-away one)
cd backend
uv sync
export TEST_DATABASE_URL=postgresql+psycopg://answers:answers@localhost:5432/postgres
uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest

# Frontend
cd ../frontend
npm ci
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
```

## Run the whole app with Docker

```sh
cp .env.example .env    # set APP_DOMAIN=http://localhost and a POSTGRES_PASSWORD to try locally
docker compose up -d --build
curl http://localhost/api/health   # {"status":"ok",...}
```

Create the first Owner, then open http://localhost and sign in:

```sh
docker compose exec api python -m app.cli create-owner --email you@example.com --name "Your Name"
```

While SMTP is not set up in `.env`, invites and password resets show the Owner a link to pass on
instead of emailing it. Server installation on the Hostinger VPS is documented in build
step 16 (`ops/deploy.md`).
