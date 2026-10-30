"""Benchmarks and batches made through the API, for the tests that need them."""

from typing import Any

from fastapi.testclient import TestClient

WEBSITE: dict[str, Any] = {
    "services": [
        {"name": "Deep cleaning", "synonyms": ["deep clean"], "must_have": True},
        {"name": "Move-out cleaning", "synonyms": ["end of lease", "move out"]},
        {"name": "Carpet cleaning", "must_have": False},
    ],
    "service_page": {"min_words": 800},
    "blog": {"posts_per_month": 2, "topics": ["Cost guide", "Move-out checklist"]},
}
GBP: dict[str, Any] = {
    "additional_categories": 4,
    "photos": 120,
    "posts_90_days": 9,
    "description_length": 690,
    "reviews": 150,
    "rating": 4.8,
    "review_reply_pct": 85,
}


def make_benchmark(
    client: TestClient, name: str = "Cleaning Benchmark 1", niche: str = "Cleaning"
) -> dict[str, Any]:
    response = client.post(
        "/api/benchmarks", json={"name": name, "niche": niche, "gbp": GBP, "website": WEBSITE}
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def make_batch(
    client: TestClient,
    name: str = "Batch 1",
    niche: str = "Cleaning",
    benchmark_id: str | None = None,
) -> dict[str, Any]:
    if benchmark_id is None:
        found = [b for b in client.get("/api/benchmarks").json() if b["niche"] == niche]
        benchmark_id = (
            found[0]["id"] if found else make_benchmark(client, f"{niche} B1", niche)["id"]
        )
    response = client.post(
        "/api/batches", json={"name": name, "niche": niche, "benchmark_id": benchmark_id}
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def batch_id(client: TestClient, name: str = "Batch 1", niche: str = "Cleaning") -> str:
    """The batch's id, made the first time it is asked for."""
    for batch in client.get("/api/batches").json():
        if batch["name"] == name:
            return str(batch["id"])
    return str(make_batch(client, name, niche)["id"])


def task_id_of(client: TestClient, task_key: str) -> str:
    for task in client.get("/api/tasks").json():
        if task["key"] == task_key:
            return str(task["id"])
    raise AssertionError(f"no task {task_key}")


def put_bot(
    client: TestClient,
    batch: str,
    bot: str,
    task_key: str | None = None,
    share: str = "all",
    start: bool = True,
) -> dict[str, Any]:
    """Add the bot's task to the batch (when missing) and the bot to it, then start it."""
    task = task_id_of(client, task_key or bot)
    pipeline = client.get(f"/api/batches/{batch}/pipeline").json()
    present = {slot["task_id"] for step in pipeline["steps"] for slot in step["tasks"]}
    if task not in present:
        added = client.post(f"/api/batches/{batch}/tasks", json={"task_id": task, "share": share})
        assert added.status_code == 201, added.text
    response = client.post(f"/api/batches/{batch}/tasks/{task}/bots", json={"key": bot})
    assert response.status_code == 200, response.text
    if start:
        response = client.post(f"/api/batches/{batch}/start")
        assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body
