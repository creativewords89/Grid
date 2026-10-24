"""FastAPI application. Every route lives under `/api`; Caddy serves the React app."""

from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response

from app import __version__, errors, logs
from app.api import (
    answer_log,
    answers,
    audit_log,
    auth,
    conversations,
    files,
    health,
    kb,
    me,
    notifications,
    reviews,
    system,
    telegram,
    threads,
    trash,
    updates,
    usage,
    users,
    verified,
)
from app.api import settings as settings_api
from app.config import get_settings

# Caddy sets these for the whole site (SPEC 11). The API sets them as well so they hold even
# when it is reached without Caddy (on the server itself, or in development).
API_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Cache-Control": "no-store",
}
# API responses are JSON, plus the small stop-emails page (a form that posts to itself).
API_CSP = "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"


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
        title="GridRankers Answer Engine",
        version=__version__,
        docs_url=docs,
        redoc_url=None,
        openapi_url=None if settings.is_production else "/api/openapi.json",
    )
    errors.install(app)
    app.middleware("http")(security_headers)
    app.middleware("http")(logs.request_ids)  # added last, so it runs first
    for module in (
        health,
        auth,
        users,
        me,
        files,
        trash,
        audit_log,
        kb,
        conversations,
        answers,
        answer_log,
        reviews,
        settings_api,
        telegram,
        verified,
        notifications,
        updates,
        threads,
        usage,
        system,
    ):
        app.include_router(module.router, prefix="/api")
    return app


def serve() -> FastAPI:
    """The production entry point (`uvicorn --factory app.main:serve`): JSON logs first."""
    logs.setup(json_logs=True)
    return create_app()


app = create_app()
