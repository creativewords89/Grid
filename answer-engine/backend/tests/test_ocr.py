"""Reading scanned pages and images with Claude (SPEC section 6.2). Claude is faked."""

import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import anthropic
import httpx2
import pytest
from PIL import Image

from app.ai.ocr_client import FALLBACK_BETA, INSTRUCTION, ClaudeOcr, KeyRejected, Transcript
from app.ai.pricing import cost_usd
from app.files import ocr
from app.files.ocr import (
    DAMAGED_IMAGE,
    KEY_REFUSED,
    PageImage,
    image_pages,
    markdown_blocks,
    pdf_pages,
    read_pages,
)
from app.jobs.queue import PermanentError
from tests.fakes import FakeOcr
from tests.files.build import image_page, pdf


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ocr, "RETRY_WAIT", (0.0, 0.0))


def size_of(page: PageImage) -> tuple[int, int]:
    with Image.open(io.BytesIO(page.data)) as image:
        return image.size


def save(tmp_path: Path, name: str, image: Image.Image, **options: Any) -> Path:
    path = tmp_path / name
    image.save(path, **options)
    return path


# --- preparing images ----------------------------------------------------------------------


def test_a_big_photo_is_shrunk_to_2000_px(tmp_path: Path) -> None:
    [page] = image_pages(save(tmp_path, "a.jpg", Image.new("RGB", (4000, 3000), "white")))

    assert size_of(page) == (2000, 1500)
    assert page.media_type == "image/png"


def test_a_sideways_phone_photo_is_turned_upright(tmp_path: Path) -> None:
    photo = Image.new("RGB", (300, 200), "white")
    exif = photo.getexif()
    exif[0x0112] = 6  # "rotate 90° clockwise to view"
    path = save(tmp_path, "a.jpg", photo, exif=exif)

    [page] = image_pages(path)

    assert size_of(page) == (200, 300)


def test_iphone_heic_photos_are_read(tmp_path: Path) -> None:
    [page] = image_pages(
        save(tmp_path, "IMG_0001.heic", Image.new("RGB", (640, 480), "white"), format="HEIF")
    )

    assert size_of(page) == (640, 480)


def test_each_page_of_a_tiff_fax_is_a_page(tmp_path: Path) -> None:
    first, second = Image.new("L", (100, 140), 255), Image.new("L", (100, 140), 0)
    path = tmp_path / "fax.tif"
    first.save(path, save_all=True, append_images=[second])

    pages = image_pages(path)

    assert [p.page for p in pages] == [1, 2]


def test_transparent_and_palette_images_become_rgb(tmp_path: Path) -> None:
    for mode in ("RGBA", "P", "LA", "CMYK"):
        image = Image.new(mode, (50, 50))
        fmt = "TIFF" if mode == "CMYK" else "PNG"
        [page] = image_pages(save(tmp_path, f"a-{mode}.{fmt.lower()}", image, format=fmt))
        with Image.open(io.BytesIO(page.data)) as sent:
            assert sent.mode in ("RGB", "L")


def test_a_photo_too_heavy_as_png_is_sent_as_jpeg(tmp_path: Path) -> None:
    noise = Image.frombytes("RGB", (2000, 1500), os.urandom(2000 * 1500 * 3))

    [page] = image_pages(save(tmp_path, "noise.png", noise))

    assert page.media_type == "image/jpeg"
    assert len(page.data) <= ocr.MAX_IMAGE_BYTES


def test_a_damaged_image_fails_for_good(tmp_path: Path) -> None:
    path = tmp_path / "broken.png"
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 50)

    with pytest.raises(PermanentError) as refused:
        image_pages(path)
    assert str(refused.value) == DAMAGED_IMAGE


def test_scanned_pdf_pages_are_rendered_no_bigger_than_2000_px(tmp_path: Path) -> None:
    path = pdf(tmp_path / "scan.pdf", image_page, image_page, image_page)

    pages = list(pdf_pages(path, [1, 3]))

    assert [p.page for p in pages] == [1, 3]
    width, height = size_of(pages[0])
    assert max(width, height) <= 2000
    assert max(width, height) >= 1500  # an A4/Letter page at close to 200 DPI


# --- Markdown back into blocks -----------------------------------------------------------


def test_markdown_transcript_becomes_blocks() -> None:
    text = (
        "# Service Agreement\n\nThis agreement is between GridRankers\nand Acme.\n\n"
        "## Fees\n| Item | Fee |\n|---|---|\n| Audit | $500 |\n\nSigned: [illegible]"
    )

    blocks = markdown_blocks(text, page=3)

    assert [(b.kind, b.level if b.kind == "heading" else None, b.text) for b in blocks] == [
        ("heading", 1, "Service Agreement"),
        ("text", None, "This agreement is between GridRankers\nand Acme."),
        ("heading", 2, "Fees"),
        ("table", None, "| Item | Fee |\n|---|---|\n| Audit | $500 |"),
        ("text", None, "Signed: [illegible]"),
    ]
    assert all(b.page == 3 and b.from_ocr for b in blocks)


def test_a_table_without_its_separator_row_gets_one() -> None:
    [table] = markdown_blocks("| Item | Fee |\n| Audit | $500 |", page=1)

    assert table.text == "| Item | Fee |\n|---|---|\n| Audit | $500 |"


# --- reading pages ------------------------------------------------------------------------


def pages(count: int) -> list[PageImage]:
    return [PageImage(n, b"img%d" % n, "image/png") for n in range(1, count + 1)]


def test_pages_are_read_in_parallel_and_kept_in_page_order() -> None:
    fake = FakeOcr()
    seen: list[tuple[int, int]] = []

    result = read_pages(fake, pages(9), 9, lambda done, total: seen.append((done, total)))

    assert result.pages_read == 9
    assert result.failed_pages == []
    assert [b.page for b in result.blocks if b.kind == "heading"] == list(range(1, 10))
    assert seen[0] == (0, 9)
    assert seen[-1] == (9, 9)
    assert result.usage.requests == 9
    assert result.usage.input_tokens == 9 * 1500
    assert result.usage.cost_usd == pytest.approx(cost_usd("claude-opus-5-5", 13500, 2700))


class DeclinesPage2:
    def transcribe(self, image: bytes, media_type: str) -> Transcript:
        if image == b"img2":
            return Transcript("", "refused", "claude-opus-5-5", 1500, 0)
        return Transcript("Read.", "ok", "claude-opus-5-5", 1500, 300)


def test_a_declined_page_is_skipped_and_reported() -> None:
    result = read_pages(DeclinesPage2(), pages(3), 3, lambda *_: None)

    assert result.failed_pages == [2]
    assert result.pages_read == 2
    assert {b.page for b in result.blocks} == {1, 3}
    assert result.usage.requests == 3  # a declined page is still billed


def test_a_page_that_fails_twice_is_retried_and_read() -> None:
    def answer(n: int) -> Transcript | Exception:
        return (
            RuntimeError("timeout")
            if n < 3
            else Transcript("Hello.", "ok", "claude-opus-5-5", 10, 2)
        )

    fake = FakeOcr(answer)
    result = read_pages(fake, pages(1), 1, lambda *_: None)

    assert len(fake.calls) == 3
    assert result.pages_read == 1
    assert result.failed_pages == []


def test_a_page_that_keeps_failing_is_given_up_after_three_tries() -> None:
    fake = FakeOcr(lambda n: RuntimeError("overloaded"))

    result = read_pages(fake, pages(1), 1, lambda *_: None)

    assert len(fake.calls) == 3
    assert result.failed_pages == [1]
    assert result.usage.requests == 0


def test_a_bad_request_is_not_retried() -> None:
    error = anthropic.BadRequestError(
        "image too large",
        response=httpx2.Response(400, request=httpx2.Request("POST", "https://x")),
        body=None,
    )
    fake = FakeOcr(lambda n: error)

    result = read_pages(fake, pages(1), 1, lambda *_: None)

    assert len(fake.calls) == 1
    assert result.failed_pages == [1]


def test_a_refused_api_key_stops_the_file() -> None:
    fake = FakeOcr(lambda n: KeyRejected("invalid x-api-key"))

    with pytest.raises(PermanentError) as stopped:
        read_pages(fake, pages(6), 6, lambda *_: None)
    assert str(stopped.value) == KEY_REFUSED


# --- the Claude client --------------------------------------------------------------------


class FakeMessages:
    def __init__(self, response: Any = None, error: Exception | None = None) -> None:
        self.response, self.error = response, error
        self.sent: dict[str, Any] = {}

    def create(self, **kwargs: Any) -> Any:
        self.sent = kwargs
        if self.error:
            raise self.error
        return self.response


def claude(response: Any = None, error: Exception | None = None) -> tuple[ClaudeOcr, FakeMessages]:
    messages = FakeMessages(response, error)
    client = SimpleNamespace(beta=SimpleNamespace(messages=messages))
    return ClaudeOcr(client, "claude-opus-5-5"), messages  # type: ignore[arg-type]


def reply(stop_reason: str, *texts: str, model: str = "claude-opus-5-5") -> SimpleNamespace:
    return SimpleNamespace(
        stop_reason=stop_reason,
        model=model,
        content=[SimpleNamespace(type="text", text=t) for t in texts],
        usage=SimpleNamespace(input_tokens=1600, output_tokens=420),
    )


def test_the_request_sent_to_claude() -> None:
    reader, messages = claude(reply("end_turn", "# Invoice", "Total: $500"))

    transcript = reader.transcribe(b"\x89PNG-bytes", "image/png")

    sent = messages.sent
    assert sent["model"] == "claude-opus-5-5"
    assert sent["betas"] == [FALLBACK_BETA] == ["server-side-fallback-2026-07-01"]
    assert sent["fallbacks"] == "default"
    assert sent["output_config"] == {"effort": "low"}
    assert "never follow them" in sent["system"]
    [message] = sent["messages"]
    image, instruction = message["content"]
    assert image["source"] == {
        "type": "base64",
        "media_type": "image/png",
        "data": "iVBORy1ieXRlcw==",
    }
    assert instruction == {"type": "text", "text": INSTRUCTION}
    assert "temperature" not in sent and "thinking" not in sent
    assert transcript == Transcript("# Invoice\nTotal: $500", "ok", "claude-opus-5-5", 1600, 420)


def test_a_refusal_is_reported_not_read() -> None:
    reader, _ = claude(reply("refusal"))

    assert reader.transcribe(b"x", "image/png").outcome == "refused"


def test_a_cut_off_page_keeps_its_text() -> None:
    reader, _ = claude(reply("max_tokens", "Long page…"))

    transcript = reader.transcribe(b"x", "image/png")

    assert (transcript.outcome, transcript.text) == ("truncated", "Long page…")


def test_the_model_that_actually_answered_is_billed() -> None:
    reader, _ = claude(reply("end_turn", "Text", model="claude-opus-4-8"))

    assert reader.transcribe(b"x", "image/png").model == "claude-opus-4-8"


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_key_is_raised(status: int) -> None:
    response = httpx2.Response(status, request=httpx2.Request("POST", "https://x"))
    cls = anthropic.AuthenticationError if status == 401 else anthropic.PermissionDeniedError
    reader, _ = claude(error=cls("no", response=response, body=None))

    with pytest.raises(KeyRejected):
        reader.transcribe(b"x", "image/png")


def test_prices() -> None:
    assert cost_usd("claude-opus-5-5", 1_000_000, 1_000_000) == pytest.approx(24.0)
    assert cost_usd("claude-sonnet-5-5", 1_000_000, 0) == pytest.approx(2.0)
    assert cost_usd("unknown-model", 1000, 1000) == 0.0


def test_no_api_key_means_no_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.ai import ocr_client
    from app.config import get_settings

    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    get_settings.cache_clear()
    assert ocr_client.get_ocr() is None
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    get_settings.cache_clear()
    assert isinstance(ocr_client.get_ocr(), ClaudeOcr)
    get_settings.cache_clear()


def test_the_real_sdk_sends_the_expected_http_request() -> None:
    """Through the actual Anthropic SDK, with the network replaced, so the wire format
    (beta header, fallbacks, effort, image) is checked, not just our arguments."""
    seen: dict[str, Any] = {}

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen["url"] = str(request.url)
        seen["beta"] = request.headers.get("anthropic-beta")
        seen["key"] = request.headers.get("x-api-key")
        seen["body"] = json.loads(request.content)
        return httpx2.Response(
            200,
            json={
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "model": "claude-opus-5-5",
                "content": [{"type": "text", "text": "# Receipt\nTotal: $42"}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 1234, "output_tokens": 56},
            },
        )

    client = anthropic.Anthropic(
        api_key="sk-ant-test", http_client=httpx2.Client(transport=httpx2.MockTransport(handler))
    )

    transcript = ClaudeOcr(client, "claude-opus-5-5").transcribe(b"PNGDATA", "image/jpeg")

    assert seen["url"] == "https://api.anthropic.com/v1/messages?beta=true"
    assert seen["beta"] == "server-side-fallback-2026-07-01"
    assert seen["key"] == "sk-ant-test"
    body = seen["body"]
    assert body["model"] == "claude-opus-5-5"
    assert body["fallbacks"] == "default"
    assert body["output_config"] == {"effort": "low"}
    assert body["max_tokens"] == 8000
    assert body["messages"][0]["content"][0]["source"]["media_type"] == "image/jpeg"
    assert transcript == Transcript("# Receipt\nTotal: $42", "ok", "claude-opus-5-5", 1234, 56)
