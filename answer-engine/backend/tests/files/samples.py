"""Tiny files of each type, built in memory so tests need no fixtures on disk."""

import io
import zipfile

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 24
TIFF = b"II*\x00" + b"\x00" * 32
HEIC = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic" + b"\x00" * 16
OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 32
CSV = "Client,Fee\nAcme,500\nCafé Rio,750\n".encode()
CSV_WINDOWS = "Client,Fee\nCafé Rio,750\n".encode("cp1252")


def office(*members: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name in ("[Content_Types].xml", *members):
            archive.writestr(name, "<x/>")
    return buffer.getvalue()


DOCX = office("word/document.xml")
XLSX = office("xl/workbook.xml")


def pdf(marker: str) -> bytes:
    """A distinct PDF each call, so uploads aren't refused as duplicates."""
    return PDF + f"% {marker}\n".encode()
