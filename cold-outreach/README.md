# GridRankers Cold Outreach

AI agents that audit local businesses (Google Business Profile, website, social media) and turn
what they find into outreach, all run from one website, the **Agent Hub**.

- [PLAN.md](PLAN.md): the whole system and every decision so far. Start here.
- [hub/SPEC.md](hub/SPEC.md): the Agent Hub (hub.gridrankers.com) and its build steps.
- [agents/demo/agent.py](agents/demo/agent.py): a demo agent for trying the Hub. Add an agent
  on the Agents screen, then run `HUB_URL=… AGENT_TOKEN=… python agents/demo/agent.py`.
- The real agents (`agents/…`) arrive after the Hub.

## Agent Hub: run the checks on your computer

Needs Python 3.12+, [uv](https://docs.astral.sh/uv/), Node 22 and a PostgreSQL 16 server.

```sh
# Backend: a Postgres user that may create databases (tests make a throw-away one)
cd hub/backend
uv sync
export TEST_DATABASE_URL=postgresql+psycopg://hub:hub@localhost:5432/postgres
uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest

# Frontend
cd ../frontend
npm ci
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
```

## Agent Hub: run it with Docker

```sh
cd hub
cp .env.example .env    # set APP_DOMAIN=http://localhost and a POSTGRES_PASSWORD to try locally
docker compose up -d --build
curl http://localhost/api/health   # {"status":"ok",...}
```

Then open http://localhost. Installing on the server is documented in build step 9
(`hub/ops/deploy.md`).
