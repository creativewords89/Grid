"""Step 16: JSON logs with request IDs (SPEC section 11)."""

import json
import logging

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app import logs
from app.jobs import queue
from tests.conftest import RunJobs


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
        response = client.get("/api/auth/me?t=secret-token")
    rid = response.headers["x-request-id"]
    assert len(rid) == 32
    [record] = [r for r in caplog.records if r.name == "access"]
    line = as_json(record)
    assert record.path == "/api/auth/me"  # type: ignore[attr-defined]
    assert record.status == 401  # type: ignore[attr-defined]
    assert "secret-token" not in json.dumps(line)


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


def test_lines_logged_by_a_job_name_it(
    db: Session, run_jobs: RunJobs, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(queue, "REGISTRY", dict(queue.REGISTRY))
    seen: list[str | None] = []

    @queue.job("test_log_job")
    def run(_db: Session, _payload: queue.Payload) -> None:
        seen.append(logs.job.get())

    queue.enqueue(db, "test_log_job")
    db.commit()

    assert run_jobs() == 1
    assert seen[0] is not None and seen[0].startswith("test_log_job:")
    assert logs.job.get() is None  # only while the job runs
