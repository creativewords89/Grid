"""FastAPI application. Every route lives under `/api`; Caddy serves the React app."""

from fastapi import FastAPI

from app import __version__, errors
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
    trash,
    users,
)
from app.config import get_settings


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
    ):
        app.include_router(module.router, prefix="/api")
    return app


app = create_app()
