"""JSON logs with request IDs (SPEC section 9)."""

import json
import logging

import pytest
from fastapi.testclient import TestClient

from app import logs


def as_json(record: logging.LogRecord) -> dict[str, object]:
    line: dict[str, object] = json.loads(logs.JsonFormatter().format(record))
    return line


def test_a_line_is_one_json_object_with_extras() -> None:
    record = logging.makeLogRecord(
        {"name": "x", "levelname": "WARNING", "msg": "%s failed", "args": ("sync",), "ops": 3}
    )
    line = as_json(record)
    assert line["level"] == "warning"
    assert line["message"] == "sync failed"
    assert line["ops"] == 3
    assert "request_id" not in line
    assert str(line["time"]).endswith("+00:00")


def test_errors_carry_the_traceback() -> None:
    try:
        raise ValueError("bad")
    except ValueError:
        import sys

        record = logging.makeLogRecord({"msg": "oops", "exc_info": sys.exc_info()})
    assert "ValueError: bad" in str(as_json(record)["error"])


def test_each_request_gets_an_id_in_the_response_and_the_logs(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="access"):
        response = client.get("/api/auth/me?email=boss@top.com")
    rid = response.headers["x-request-id"]
    assert len(rid) == 32
    [record] = [r for r in caplog.records if r.name == "access"]
    line = as_json(record)
    assert record.path == "/api/auth/me"  # type: ignore[attr-defined]
    assert record.status == 401  # type: ignore[attr-defined]
    assert "boss@top.com" not in json.dumps(line)


def test_a_sensible_incoming_id_is_kept(client: TestClient) -> None:
    kept = client.get("/api/health", headers={"X-Request-ID": "caddy-1234abcd"})
    assert kept.headers["x-request-id"] == "caddy-1234abcd"
    replaced = client.get("/api/health", headers={"X-Request-ID": "x\nforged log line"})
    assert replaced.headers["x-request-id"] != "x\nforged log line"
    assert len(replaced.headers["x-request-id"]) == 32


def test_health_checks_arent_logged(client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger="access"):
        client.get("/api/health")
    assert [r for r in caplog.records if r.name == "access"] == []
