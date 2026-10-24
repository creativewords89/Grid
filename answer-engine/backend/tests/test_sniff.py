from pathlib import Path

import pytest

from app.files import sniff
from tests.files import samples


def detect(tmp_path: Path, content: bytes, name: str) -> sniff.FileType:
    path = tmp_path / "upload"
    path.write_bytes(content)
    return sniff.detect(path, name)


@pytest.mark.parametrize(
    ("content", "name", "expected"),
    [
        (samples.PDF, "Pricing.pdf", sniff.PDF),
        (b"\n\n" + samples.PDF, "leading-junk.PDF", sniff.PDF),
        (samples.DOCX, "Contract.docx", sniff.DOCX),
        (samples.XLSX, "Fees 2026.xlsx", sniff.XLSX),
        (samples.CSV, "fees.csv", sniff.CSV),
        (samples.CSV_WINDOWS, "excel-export.csv", sniff.CSV),
        (samples.PNG, "scan.png", sniff.PNG),
        (samples.JPEG, "photo.jpg", sniff.JPEG),
        (samples.JPEG, "photo.JPEG", sniff.JPEG),
        (samples.WEBP, "shot.webp", sniff.WEBP),
        (samples.TIFF, "fax.tif", sniff.TIFF),
        (samples.TIFF, "fax.tiff", sniff.TIFF),
        (samples.HEIC, "IMG_0001.HEIC", sniff.HEIC),
    ],
)
def test_detects_accepted_types(
    tmp_path: Path, content: bytes, name: str, expected: sniff.FileType
) -> None:
    assert detect(tmp_path, content, name) == expected


@pytest.mark.parametrize(
    ("content", "name", "message"),
    [
        (b"", "empty.pdf", sniff.EMPTY),
        (b"just some notes", "notes.txt", sniff.UNSUPPORTED),
        (b"MZ\x90\x00", "setup.exe", sniff.UNSUPPORTED),
        (samples.office("ppt/presentation.xml"), "deck.pptx", sniff.UNSUPPORTED),
        (b"PK\x03\x04 not really a zip", "broken.docx", sniff.UNSUPPORTED),
        (samples.OLE, "old.doc", sniff.OLD_OFFICE),
        (samples.OLE, "old.xls", sniff.OLD_OFFICE),
        (b"a,b\n\x00\x01", "binary.csv", sniff.UNSUPPORTED),
        (samples.CSV, "fees.txt", sniff.UNSUPPORTED),
    ],
)
def test_refuses_unsupported_files(tmp_path: Path, content: bytes, name: str, message: str) -> None:
    with pytest.raises(sniff.SniffError) as refused:
        detect(tmp_path, content, name)

    assert str(refused.value) == message


@pytest.mark.parametrize(
    ("content", "name", "described"),
    [
        (samples.PNG, "invoice.pdf", "a PNG image"),
        (samples.PDF, "photo.png", "a PDF"),
        (samples.XLSX, "report.docx", "an Excel workbook"),
        (samples.PDF, "no-extension", "a PDF"),
    ],
)
def test_refuses_a_name_that_does_not_match_the_content(
    tmp_path: Path, content: bytes, name: str, described: str
) -> None:
    with pytest.raises(sniff.SniffError, match=rf"\(it is really {described}\)"):
        detect(tmp_path, content, name)


def test_csv_with_a_character_cut_at_the_sample_edge_is_still_text(tmp_path: Path) -> None:
    content = b"a" * (64 * 1024 - 1) + "é".encode()  # é's second byte falls past 64 KB

    assert detect(tmp_path, content, "long.csv") == sniff.CSV
