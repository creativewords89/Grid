"""Work out a file's type from its content, not its name (SPEC section 6.1)."""

import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePath


@dataclass(frozen=True)
class FileType:
    key: str
    label: str
    described: str  # for messages: "it is really {described}"
    mime: str
    extensions: frozenset[str]


def _t(key: str, label: str, described: str, mime: str, *extensions: str) -> FileType:
    return FileType(key, label, described, mime, frozenset(extensions))


PDF = _t("pdf", "PDF", "a PDF", "application/pdf", ".pdf")
DOCX = _t(
    "docx",
    "Word",
    "a Word document",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".docx",
)
XLSX = _t(
    "xlsx",
    "Excel",
    "an Excel workbook",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsx",
)
CSV = _t("csv", "CSV", "a CSV file", "text/csv", ".csv")
PNG = _t("png", "Image", "a PNG image", "image/png", ".png")
JPEG = _t("jpeg", "Image", "a JPEG image", "image/jpeg", ".jpg", ".jpeg")
WEBP = _t("webp", "Image", "a WebP image", "image/webp", ".webp")
TIFF = _t("tiff", "Image", "a TIFF image", "image/tiff", ".tif", ".tiff")
HEIC = _t("heic", "Image", "a HEIC photo", "image/heic", ".heic")

ALL_TYPES = (PDF, DOCX, XLSX, CSV, PNG, JPEG, WEBP, TIFF, HEIC)
BY_MIME = {t.mime: t for t in ALL_TYPES}

UNSUPPORTED = "This file type isn't supported. Save it as PDF, Word (.docx) or Excel (.xlsx)."
OLD_OFFICE = "Old Word and Excel files (.doc, .xls) aren't supported. Save it as .docx or .xlsx."
EMPTY = "This file is empty."
PROTECTED = "This file is password-protected. Remove the password and upload it again."
# A password-protected .docx/.xlsx is an old-style Office container holding this stream.
_ENCRYPTED_PACKAGE = "EncryptedPackage".encode("utf-16-le")

_HEIC_BRANDS = {b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1"}


class SniffError(ValueError):
    """The file is refused; the message is shown to the person who uploaded it."""


def _from_magic(head: bytes, path: Path) -> FileType | None:
    if b"%PDF-" in head[:1024]:
        return PDF
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return PNG
    if head.startswith(b"\xff\xd8\xff"):
        return JPEG
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return WEBP
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return TIFF
    if head[4:8] == b"ftyp" and head[8:12] in _HEIC_BRANDS:
        return HEIC
    if head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        raise SniffError(PROTECTED if _ENCRYPTED_PACKAGE in path.read_bytes() else OLD_OFFICE)
    if head.startswith(b"PK\x03\x04"):
        return _office_type(path)
    return None


def _office_type(path: Path) -> FileType | None:
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
    except (zipfile.BadZipFile, OSError):
        return None
    if "[Content_Types].xml" not in names:
        return None
    if "word/document.xml" in names:
        return DOCX
    if "xl/workbook.xml" in names:
        return XLSX
    return None


def _looks_like_text(head: bytes) -> bool:
    """Plain text in UTF-8 or Windows-1252 (Excel's CSV export), with no NUL bytes."""
    if b"\x00" in head:
        return False
    try:
        head.decode("utf-8")
    except UnicodeDecodeError as exc:
        # A multi-byte character cut off by the 64 KB sample is still UTF-8.
        if exc.start < len(head) - 3:
            try:
                head.decode("cp1252")
            except UnicodeDecodeError:
                return False
    return True


def detect(path: Path, filename: str) -> FileType:
    """The file's type, or SniffError with a message for the uploader."""
    with path.open("rb") as handle:
        head = handle.read(64 * 1024)
    if not head:
        raise SniffError(EMPTY)
    extension = PurePath(filename).suffix.lower()

    found = _from_magic(head, path)
    if found is None and extension == ".csv" and _looks_like_text(head):
        found = CSV
    if found is None:
        raise SniffError(UNSUPPORTED)
    if extension not in found.extensions:
        raise SniffError(
            f"This file's name doesn't match its content (it is really {found.described}). "
            "Check you picked the right file."
        )
    return found
