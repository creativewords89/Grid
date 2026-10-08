from collections.abc import Iterator

from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

from app import __version__
from app.db.session import get_session
from app.main import create_app


def _client_with(engine: Engine) -> TestClient:
    app = create_app()

    def session_override() -> Iterator[Session]:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = session_override
    return TestClient(app)


def test_health_ok_when_database_reachable(engine: Engine) -> None:
    response = _client_with(engine).get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "version": __version__,
        "checks": {"database": "ok"},
    }


def test_health_503_when_database_unreachable() -> None:
    dead = create_engine(
        "postgresql+psycopg://nobody:nothing@127.0.0.1:1/none",
        connect_args={"connect_timeout": 1},
    )

    response = _client_with(dead).get("/api/health")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "error"
    assert body["checks"] == {"database": "error"}


def test_unknown_api_route_uses_error_shape() -> None:
    response = TestClient(create_app()).get("/api/nope")

    assert response.status_code == 404
    assert response.json() == {"error": {"code": "not_found", "message": "Not found."}}
