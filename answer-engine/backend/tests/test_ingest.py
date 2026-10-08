"""Upload → worker → chunks (SPEC sections 6.1 and 6.3)."""

from pathlib import Path
from typing import Any

import docx.document
import pymupdf
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Chunk, FileStatus, Job, JobState, Role, StoredFile, User
from app.files import service
from app.jobs.queue import enqueue
from tests.conftest import RunJobs, UserFactory, sign_in
from tests.files import samples
from tests.files.build import LOREM, image_page, locked_pdf, page_break, pdf, text, word
from tests.test_extract_sheet import FIXTURES


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER)
    sign_in(client, user.email)
    return user


def upload(client: TestClient, path: Path) -> dict[str, Any]:
    response = client.post("/api/files", files=[("files", (path.name, path.read_bytes()))])
    [result] = response.json()["results"]
    assert result["error"] is None, result
    file: dict[str, Any] = result["file"]
    return file


def chunks(db: Session, file_id: str) -> list[Chunk]:
    return list(
        db.scalars(select(Chunk).where(Chunk.file_id == file_id).order_by(Chunk.position)).all()
    )


def listed(client: TestClient, file_id: str) -> dict[str, Any]:
    file: dict[str, Any] = next(
        f for f in client.get("/api/files").json()["files"] if f["id"] == file_id
    )
    return file


def long_pdf(path: Path, pages: int = 6) -> Path:
    def page(n: int):  # type: ignore[no-untyped-def]
        def write(p: pymupdf.Page) -> None:
            y = text(p, 50, f"Section {n}", size=18)
            for _ in range(4):
                y = text(p, y, f"Page {n}. " + LOREM + " " + LOREM)

        return write

    return pdf(path, *(page(n) for n in range(1, pages + 1)))


def test_a_pdf_is_read_into_chunks(
    client: TestClient, owner: User, db: Session, run_jobs: RunJobs, tmp_path: Path
) -> None:
    file = upload(client, long_pdf(tmp_path / "Pricing.pdf"))

    run_jobs()

    found = chunks(db, file["id"])
    assert len(found) >= 3
    assert [c.id for c in found] == [f"doc_{file['id']}_{n}" for n in range(len(found))]
    assert found[0].heading == "Section 1"
    assert found[0].page_from == 1
    assert found[-1].page_to == 6
    assert all(c.token_count <= 800 for c in found)
    assert not any(c.from_ocr for c in found)
    row = listed(client, file["id"])
    assert (row["status"], row["page_count"], row["chunk_count"], row["warning"]) == (
        "ready",
        6,
        len(found),
        None,
    )


def test_a_word_document_is_read_into_chunks(
    client: TestClient, owner: User, db: Session, run_jobs: RunJobs, tmp_path: Path
) -> None:
    def build(d: docx.document.Document) -> None:
        d.add_heading("Onboarding", 0)
        d.add_paragraph(LOREM)
        page_break(d)
        d.add_heading("Reporting", 1)
        d.add_paragraph(LOREM)

    file = upload(client, word(tmp_path / "Onboarding.docx", build, pages=2))
    run_jobs()

    [chunk] = chunks(db, file["id"])
    assert chunk.text.startswith("# Onboarding\n\n" + LOREM)
    assert "# Reporting" in chunk.text
    assert chunk.heading == "Onboarding"
    assert (chunk.page_from, chunk.page_to) == (1, 2)
    assert listed(client, file["id"])["page_count"] == 2


def test_scanned_pages_are_reported_on_the_file(
    client: TestClient, owner: User, db: Session, run_jobs: RunJobs, tmp_path: Path
) -> None:
    path = pdf(tmp_path / "Mixed.pdf", lambda p: text(p, 60, LOREM), image_page, image_page)

    file = upload(client, path)
    run_jobs()

    row = listed(client, file["id"])
    assert row["status"] == "ready"
    assert row["warning"] == (
        "2 pages look scanned and will be read once scanned-page reading is switched on."
    )
    assert len(chunks(db, file["id"])) == 1


def test_a_pdf_with_no_text_at_all_says_so(
    client: TestClient, owner: User, run_jobs: RunJobs, tmp_path: Path
) -> None:
    file = upload(client, pdf(tmp_path / "Scan.pdf", image_page))
    run_jobs()

    assert listed(client, file["id"])["warning"].startswith("1 page looks scanned")


def test_a_word_file_with_no_text_says_so(
    client: TestClient, owner: User, run_jobs: RunJobs, tmp_path: Path
) -> None:
    file = upload(client, word(tmp_path / "Empty.docx", lambda d: d.add_paragraph("")))
    run_jobs()

    assert listed(client, file["id"])["warning"] == "No text was found in this file."


def test_a_password_protected_pdf_fails_at_once(
    client: TestClient, owner: User, db: Session, run_jobs: RunJobs, tmp_path: Path
) -> None:
    path = locked_pdf(tmp_path / "Locked.pdf")
    file = upload(client, path)

    run_jobs()

    row = listed(client, file["id"])
    assert row["status"] == "failed"
    assert (
        row["error"] == "This PDF is password-protected. Remove the password and upload it again."
    )
    job = db.scalars(select(Job)).one()
    assert (job.state, job.attempts) == (JobState.FAILED, 3)  # no pointless retries


def test_images_wait_for_scanned_page_reading(
    client: TestClient, owner: User, run_jobs: RunJobs, tmp_path: Path
) -> None:
    photo = tmp_path / "scan.png"
    photo.write_bytes(samples.PNG)
    file = upload(client, photo)

    run_jobs()

    assert listed(client, file["id"])["warning"] == (
        "Images will be read once scanned-page reading is switched on."
    )


def test_an_excel_workbook_is_read_sheet_by_sheet(
    client: TestClient, owner: User, db: Session, run_jobs: RunJobs, tmp_path: Path
) -> None:
    path = tmp_path / "Fees 2026.xlsx"
    path.write_bytes((FIXTURES / "fees-calculated.xlsx").read_bytes())
    file = upload(client, path)

    run_jobs()

    found = chunks(db, file["id"])
    assert [(c.sheet, c.heading) for c in found] == [
        ("Fees 2026", "Fees 2026"),
        ("Contacts", "Contacts"),
    ]
    assert "Row 7: Client: Bright Dental; Plan: Agency; Monthly fee: $2,000" in found[0].text
    row = listed(client, file["id"])
    assert (row["sheet_count"], row["page_count"], row["warning"]) == (2, None, None)


def test_a_csv_file_is_read(
    client: TestClient, owner: User, db: Session, run_jobs: RunJobs, tmp_path: Path
) -> None:
    path = tmp_path / "leads.csv"
    path.write_text("Name,Source\nAnn,Reddit\nBo,Facebook\n")
    file = upload(client, path)

    run_jobs()

    [chunk] = chunks(db, file["id"])
    assert chunk.text == (
        "File: leads.csv\nColumns: Name; Source\n\n"
        "Row 2: Name: Ann; Source: Reddit\nRow 3: Name: Bo; Source: Facebook"
    )
    assert listed(client, file["id"])["sheet_count"] is None


def test_reading_a_file_again_replaces_its_chunks(
    client: TestClient, owner: User, db: Session, run_jobs: RunJobs, tmp_path: Path
) -> None:
    file = upload(client, long_pdf(tmp_path / "Pricing.pdf"))
    run_jobs()
    first = [c.id for c in chunks(db, file["id"])]

    enqueue(db, service.INGEST, {"file_id": file["id"]})
    db.commit()
    run_jobs()

    assert [c.id for c in chunks(db, file["id"])] == first


def test_deleting_forever_removes_the_chunks(
    client: TestClient, owner: User, db: Session, run_jobs: RunJobs, tmp_path: Path
) -> None:
    file = upload(client, long_pdf(tmp_path / "Pricing.pdf", pages=2))
    run_jobs()
    client.delete(f"/api/files/{file['id']}")
    [item] = client.get("/api/trash").json()

    client.delete(f"/api/trash/{item['id']}")

    assert chunks(db, file["id"]) == []
    assert db.get(StoredFile, file["id"]) is None


def test_a_new_version_gets_its_own_chunks(
    client: TestClient, owner: User, db: Session, run_jobs: RunJobs, tmp_path: Path
) -> None:
    v1 = upload(client, long_pdf(tmp_path / "Pricing.pdf", pages=2))
    run_jobs()
    v2 = client.post(
        f"/api/files/{v1['id']}/version",
        files={"file": ("Pricing v2.pdf", long_pdf(tmp_path / "v2.pdf", pages=3).read_bytes())},
    ).json()

    run_jobs()

    assert chunks(db, v2["id"])[-1].page_to == 3
    old = db.get(StoredFile, v1["id"])
    assert old is not None
    assert old.status == FileStatus.READY  # kept, in the trash
