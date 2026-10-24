"""Documents: upload, duplicates, versions, retry, download, delete and trash (SPEC 6.1, 7.2)."""

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import AuditEntry, FileStatus, Role, Setting, StoredFile, TrashItem, User
from tests.conftest import RunJobs, UserFactory, sign_in
from tests.files import samples

Upload = tuple[str, bytes]


def upload(client: TestClient, *files: Upload) -> list[dict[str, Any]]:
    response = client.post(
        "/api/files", files=[("files", (name, content)) for name, content in files]
    )
    assert response.status_code == 200, response.text
    results: list[dict[str, Any]] = response.json()["results"]
    return results


def upload_one(
    client: TestClient, name: str = "Pricing.pdf", content: bytes | None = None
) -> dict[str, Any]:
    [result] = upload(client, (name, content if content is not None else samples.pdf(name)))
    assert result["error"] is None, result
    file: dict[str, Any] = result["file"]
    return file


def stored(db: Session, file_id: str) -> StoredFile:
    record = db.scalar(
        select(StoredFile).where(StoredFile.id == file_id).execution_options(populate_existing=True)
    )
    assert record is not None
    return record


def names(client: TestClient) -> list[str]:
    return [f["name"] for f in client.get("/api/files").json()["files"]]


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER, name="Olivia")
    sign_in(client, user.email)
    return user


Login = Callable[[Role], tuple[TestClient, User]]


@pytest.fixture
def login_as(app_factory: Callable[[], TestClient], make_user: UserFactory) -> Login:
    def login(role: Role) -> tuple[TestClient, User]:
        person = make_user(role, name=role.value.title())
        c = app_factory()
        sign_in(c, person.email)
        return c, person

    return login


# --- upload --------------------------------------------------------------------------------


def test_upload_stores_the_file_and_queues_it(
    client: TestClient, owner: User, db: Session, upload_dir: Path, run_jobs: RunJobs
) -> None:
    content = samples.pdf("pricing")

    file = upload_one(client, "../../etc/Pricing.pdf", content)

    assert file["name"] == "Pricing.pdf"
    assert (file["status"], file["type"], file["size"]) == ("queued", "PDF", len(content))
    assert file["uploaded_by"]["name"] == "Olivia"
    record = stored(db, file["id"])
    on_disk = upload_dir / record.storage_path
    assert on_disk.read_bytes() == content
    assert "Pricing" not in record.storage_path  # random name on disk
    assert list((upload_dir / "tmp").iterdir()) == []
    assert db.scalar(select(AuditEntry.action).where(AuditEntry.entity == "file")) == "add"

    assert run_jobs() == 1
    assert stored(db, file["id"]).status == FileStatus.READY


def test_one_request_can_carry_several_files_with_separate_results(
    client: TestClient, owner: User
) -> None:
    upload_one(client, "Existing.pdf", samples.PDF)

    results = upload(
        client,
        ("Contract.docx", samples.DOCX),
        ("notes.txt", b"hello"),
        ("Copy of Existing.pdf", samples.PDF),
        ("Fees.xlsx", samples.XLSX),
    )

    assert [(r["name"], r["error"] and r["error"]["code"]) for r in results] == [
        ("Contract.docx", None),
        ("notes.txt", "unsupported"),
        ("Copy of Existing.pdf", "duplicate"),
        ("Fees.xlsx", None),
    ]
    assert results[2]["error"]["message"] == (
        "This file is already in the knowledge base: Existing.pdf"
    )
    assert sorted(names(client)) == ["Contract.docx", "Existing.pdf", "Fees.xlsx"]


def test_a_deleted_file_can_be_uploaded_again(client: TestClient, owner: User) -> None:
    first = upload_one(client, "A.pdf", samples.PDF)
    client.delete(f"/api/files/{first['id']}")

    again = upload_one(client, "A again.pdf", samples.PDF)

    assert again["id"] != first["id"]


def test_files_over_the_size_limit_are_refused(
    client: TestClient, owner: User, db: Session, upload_dir: Path
) -> None:
    db.add(Setting(key="max_upload_mb", value=1))
    db.commit()

    [result] = upload(client, ("big.pdf", samples.PDF + b"0" * 1024 * 1024))

    assert result["error"] == {"code": "too_large", "message": "This file is bigger than 1 MB."}
    assert list((upload_dir / "tmp").iterdir()) == []
    assert db.scalar(select(StoredFile)) is None


def test_too_many_files_at_once_are_refused(client: TestClient, owner: User, db: Session) -> None:
    db.add(Setting(key="max_batch_files", value=2))
    db.commit()

    response = client.post(
        "/api/files",
        files=[("files", (f"{n}.pdf", samples.pdf(str(n)))) for n in range(3)],
    )

    assert response.status_code == 422
    assert response.json()["error"]["message"] == "Upload at most 2 files at a time."


def test_upload_needs_sign_in_and_the_csrf_token(
    client: TestClient, make_user: UserFactory
) -> None:
    files = [("files", ("a.pdf", samples.PDF))]
    assert client.post("/api/files", files=files).status_code == 401

    sign_in(client, make_user().email)
    client.headers.pop("X-CSRF-Token")
    assert client.post("/api/files", files=files).status_code == 403


@pytest.mark.parametrize("role", list(Role))
def test_everyone_can_upload_list_and_download(login_as: Login, role: Role) -> None:
    c, _ = login_as(role)

    file = upload_one(c, "Shared.pdf", samples.PDF)

    assert names(c) == ["Shared.pdf"]
    assert c.get(f"/api/files/{file['id']}/download").content == samples.PDF


# --- list and download ----------------------------------------------------------------------


def test_list_filters_by_name_and_type(client: TestClient, owner: User) -> None:
    upload_one(client, "Pricing 2026.pdf", samples.pdf("1"))
    upload_one(client, "Contract.docx", samples.DOCX)
    upload_one(client, "Fees.csv", samples.CSV)
    upload_one(client, "scan.png", samples.PNG)
    upload_one(client, "100%_done.pdf", samples.pdf("2"))

    def listed(query: str) -> list[str]:
        return sorted(f["name"] for f in client.get(f"/api/files?{query}").json()["files"])

    assert listed("q=pric") == ["Pricing 2026.pdf"]
    assert listed("q=100%25") == ["100%_done.pdf"]
    assert listed("q=_") == ["100%_done.pdf"]
    assert listed("type=excel") == ["Fees.csv"]
    assert listed("type=image") == ["scan.png"]
    assert listed("type=word") == ["Contract.docx"]
    assert client.get("/api/files").json()["totals"]["files"] == 5


def test_download_is_an_attachment_unless_shown_inline(client: TestClient, owner: User) -> None:
    pdf = upload_one(client, "Pricing.pdf", samples.PDF)
    docx = upload_one(client, "Contract.docx", samples.DOCX)

    attached = client.get(f"/api/files/{pdf['id']}/download")
    inline_pdf = client.get(f"/api/files/{pdf['id']}/download?inline=true")
    inline_docx = client.get(f"/api/files/{docx['id']}/download?inline=true")

    assert attached.headers["content-disposition"].startswith("attachment;")
    assert 'filename="Pricing.pdf"' in attached.headers["content-disposition"]
    assert attached.headers["content-type"] == "application/pdf"
    assert inline_pdf.headers["content-disposition"].startswith("inline;")
    assert inline_docx.headers["content-disposition"].startswith("attachment;")


def test_deleted_files_cannot_be_downloaded(client: TestClient, owner: User) -> None:
    file = upload_one(client)
    client.delete(f"/api/files/{file['id']}")

    assert client.get(f"/api/files/{file['id']}/download").status_code == 404


# --- delete and trash ------------------------------------------------------------------------


def test_a_user_may_delete_only_their_own_uploads(login_as: Login) -> None:
    user_client, _ = login_as(Role.USER)
    other_client, _ = login_as(Role.USER)
    mine = upload_one(user_client, "Mine.pdf", samples.pdf("mine"))
    theirs = upload_one(other_client, "Theirs.pdf", samples.pdf("theirs"))

    listed = {f["name"]: f["can_delete"] for f in user_client.get("/api/files").json()["files"]}
    assert listed == {"Mine.pdf": True, "Theirs.pdf": False}
    assert user_client.delete(f"/api/files/{theirs['id']}").status_code == 403
    assert user_client.delete(f"/api/files/{mine['id']}").status_code == 204


@pytest.mark.parametrize("role", [Role.REVIEWER, Role.OWNER])
def test_reviewers_and_owners_may_delete_any_file(login_as: Login, role: Role) -> None:
    user_client, _ = login_as(Role.USER)
    staff_client, _ = login_as(role)
    file = upload_one(user_client)

    assert staff_client.delete(f"/api/files/{file['id']}").status_code == 204
    assert names(user_client) == []


@pytest.mark.parametrize("role", [Role.USER, Role.REVIEWER])
def test_only_the_owner_manages_the_trash(login_as: Login, role: Role) -> None:
    c, _ = login_as(role)
    file = upload_one(c)
    c.delete(f"/api/files/{file['id']}")

    assert c.get("/api/trash").status_code == 403
    assert c.post("/api/trash/0192f3a4-0000-7000-8000-000000000000/restore").status_code == 403
    assert c.delete("/api/trash/0192f3a4-0000-7000-8000-000000000000").status_code == 403


def test_owner_restores_a_deleted_file(client: TestClient, owner: User, db: Session) -> None:
    file = upload_one(client)
    client.delete(f"/api/files/{file['id']}")
    [item] = client.get("/api/trash").json()
    assert (item["title"], item["deleted_by"], item["reason"]) == (
        "Pricing.pdf",
        "Olivia",
        "delete",
    )

    assert client.post(f"/api/trash/{item['id']}/restore").status_code == 204

    assert names(client) == ["Pricing.pdf"]
    assert client.get("/api/trash").json() == []
    actions = db.scalars(select(AuditEntry.action).order_by(AuditEntry.at)).all()
    assert actions == ["add", "delete", "restore"]


def test_restore_is_refused_when_a_copy_was_uploaded_since(client: TestClient, owner: User) -> None:
    file = upload_one(client, "A.pdf", samples.PDF)
    client.delete(f"/api/files/{file['id']}")
    upload_one(client, "A copy.pdf", samples.PDF)
    [item] = client.get("/api/trash").json()

    response = client.post(f"/api/trash/{item['id']}/restore")

    assert response.status_code == 409
    assert "A copy.pdf" in response.json()["error"]["message"]


def test_delete_forever_removes_the_original(
    client: TestClient, owner: User, db: Session, upload_dir: Path
) -> None:
    file = upload_one(client)
    on_disk = upload_dir / stored(db, file["id"]).storage_path
    client.delete(f"/api/files/{file['id']}")
    [item] = client.get("/api/trash").json()

    assert client.delete(f"/api/trash/{item['id']}").status_code == 204

    assert not on_disk.exists()
    assert db.scalar(select(StoredFile)) is None
    assert db.scalar(select(TrashItem)) is None


def test_a_file_deleted_while_queued_is_not_read_until_restored(
    client: TestClient, owner: User, db: Session, run_jobs: RunJobs
) -> None:
    file = upload_one(client)
    client.delete(f"/api/files/{file['id']}")
    run_jobs()
    assert stored(db, file["id"]).status == FileStatus.QUEUED

    [item] = client.get("/api/trash").json()
    client.post(f"/api/trash/{item['id']}/restore")
    run_jobs()

    assert stored(db, file["id"]).status == FileStatus.READY


# --- new versions --------------------------------------------------------------------------


def new_version(client: TestClient, file_id: str, name: str, content: bytes) -> Any:
    return client.post(f"/api/files/{file_id}/version", files={"file": (name, content)})


def test_a_new_version_replaces_the_old_one_once_ready(
    client: TestClient, owner: User, run_jobs: RunJobs
) -> None:
    v1 = upload_one(client, "Pricing.pdf", samples.pdf("v1"))
    run_jobs()

    response = new_version(client, v1["id"], "Pricing (Oct).pdf", samples.pdf("v2"))

    assert response.status_code == 201
    v2 = response.json()
    assert (v2["version"], v2["previous_file_id"], v2["status"]) == (2, v1["id"], "queued")
    assert sorted(names(client)) == ["Pricing (Oct).pdf", "Pricing.pdf"]  # old one still answers

    run_jobs()

    assert names(client) == ["Pricing (Oct).pdf"]
    [item] = client.get("/api/trash").json()
    assert (item["title"], item["reason"]) == ("Pricing.pdf", "replaced")


def test_only_one_new_version_at_a_time(client: TestClient, owner: User) -> None:
    v1 = upload_one(client, "Pricing.pdf", samples.pdf("v1"))
    new_version(client, v1["id"], "v2.pdf", samples.pdf("v2"))

    response = new_version(client, v1["id"], "v3.pdf", samples.pdf("v3"))

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "version_pending"


def test_a_new_version_identical_to_the_current_one_is_refused(
    client: TestClient, owner: User
) -> None:
    v1 = upload_one(client, "Pricing.pdf", samples.PDF)

    response = new_version(client, v1["id"], "Pricing.pdf", samples.PDF)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "duplicate"


def test_a_new_version_must_still_be_a_supported_file(client: TestClient, owner: User) -> None:
    v1 = upload_one(client)

    response = new_version(client, v1["id"], "notes.txt", b"hello")

    assert response.status_code == 415


# --- failures and retry ---------------------------------------------------------------------


def test_a_file_that_cannot_be_read_fails_with_a_reason_and_can_be_retried(
    client: TestClient, owner: User, db: Session, upload_dir: Path, run_jobs: RunJobs
) -> None:
    from tests.test_jobs import make_due

    file = upload_one(client)
    on_disk = upload_dir / stored(db, file["id"]).storage_path
    content = on_disk.read_bytes()
    on_disk.unlink()
    for _ in range(3):
        make_due(db)
        run_jobs()

    failed = stored(db, file["id"])
    assert failed.status == FileStatus.FAILED
    assert failed.error == "The uploaded file is missing from storage. Upload it again."
    assert client.get("/api/files").json()["files"][0]["error"] == failed.error

    on_disk.write_bytes(content)
    retried = client.post(f"/api/files/{file['id']}/retry")
    assert retried.json()["status"] == "queued"
    run_jobs()
    assert stored(db, file["id"]).status == FileStatus.READY


def test_only_failed_files_can_be_retried(client: TestClient, owner: User) -> None:
    file = upload_one(client)

    assert client.post(f"/api/files/{file['id']}/retry").status_code == 409


# --- history ---------------------------------------------------------------------------------


def test_the_owner_reads_the_history(
    client: TestClient, owner: User, make_user: UserFactory
) -> None:
    person = make_user(name="Sam")
    client.patch(f"/api/users/{person.id}", json={"role": "reviewer"})
    upload_one(client)

    history = client.get("/api/audit").json()

    assert [(h["actor"], h["action"], h["entity"], h["title"]) for h in history] == [
        ("Olivia", "add", "file", "Pricing.pdf"),
        ("Olivia", "edit", "user", "Sam"),
    ]
    assert history[1]["changes"] == [{"field": "role", "from": "user", "to": "reviewer"}]
    assert [h["entity"] for h in client.get("/api/audit?entity=user").json()] == ["user"]


@pytest.mark.parametrize("role", [Role.USER, Role.REVIEWER])
def test_only_the_owner_reads_the_history(login_as: Login, role: Role) -> None:
    c, _ = login_as(role)

    assert c.get("/api/audit").status_code == 403
