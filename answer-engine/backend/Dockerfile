# Backend image, used by both the `api` and `worker` services.
FROM python:3.12-slim AS base

RUN pip install --no-cache-dir uv==0.11.32

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY alembic.ini docker-entrypoint.sh ./
COPY app ./app

RUN useradd --system --uid 10001 --home /app answers \
    && mkdir -p /data/uploads && chown answers /data/uploads
USER answers

EXPOSE 8000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["api"]
