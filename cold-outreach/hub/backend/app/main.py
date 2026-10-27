"""FastAPI application. Every route lives under `/api`; Caddy serves the React app."""

import logging
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from sqlalchemy.orm import Session

from app import __version__, errors
from app.api import agent_api, agents, auth, connections, health, imports, me, runs, setup, users
from app.config import get_settings
from app.db.session import get_engine

# Caddy sets these for the whole site. The API sets them as well so they hold even when it
# is reached without Caddy (on the server itself, or in development).
API_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Cache-Control": "no-store",
}
API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"


async def security_headers(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    response = await call_next(request)
    for name, value in API_HEADERS.items():
        response.headers.setdefault(name, value)
    if not request.url.path.startswith("/api/docs"):  # the development-only API browser
        response.headers.setdefault("Content-Security-Policy", API_CSP)
    return response


def create_app() -> FastAPI:
    settings = get_settings()
    docs = None if settings.is_production else "/api/docs"
    app = FastAPI(
        title="GridRankers Agent Hub",
        version=__version__,
        docs_url=docs,
        redoc_url=None,
        openapi_url=None if settings.is_production else "/api/openapi.json",
    )
    errors.install(app)
    app.middleware("http")(security_headers)
    for module in (
        health,
        setup,
        auth,
        users,
        me,
        connections,
        agents,
        agent_api,
        runs,
        imports,
    ):
        app.include_router(module.router, prefix="/api")
    return app


def serve() -> FastAPI:
    """The production entry point (`uvicorn --factory app.main:serve`)."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    app = create_app()
    try:
        with Session(get_engine()) as db:
            setup.announce(db)
    except Exception:
        logging.getLogger(__name__).warning("couldn't check for a first Owner", exc_info=True)
    return app


app = create_app()
