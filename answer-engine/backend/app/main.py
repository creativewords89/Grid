"""FastAPI application. Every route lives under `/api`; Caddy serves the React app."""

from fastapi import FastAPI

from app import __version__
from app.api import health
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
    app.include_router(health.router, prefix="/api")
    return app


app = create_app()
