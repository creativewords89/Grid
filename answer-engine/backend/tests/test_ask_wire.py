"""The real Anthropic and Pinecone SDKs, with the network replaced, so the wire format of
answering is checked: Pinecone's search + rerank, and Claude's streamed answer."""

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import anthropic
import httpx2
import pytest
from pinecone import Pinecone

from app.answering.claude_answer import ClaudeAnswerer, Completion
from app.answering.prompts import ANSWER_SYSTEM
from app.kb.store import Hit, PineconeStore


@pytest.fixture
def pinecone_server() -> Iterator[tuple[PineconeStore, list[tuple[str, Any]]]]:
    seen: list[tuple[str, Any]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)))
            seen.append((self.path, body))
            hits = [
                {"_id": "doc_a_0", "_score": 0.91, "fields": {"file_id": "a"}},
                {"_id": "doc_a_1", "_score": 0.12, "fields": {}},
            ]
            data = json.dumps({"result": {"hits": hits}, "usage": {"read_units": 1}}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    store = PineconeStore.__new__(PineconeStore)
    store._index = Pinecone(api_key="pc-test").Index(host=f"http://127.0.0.1:{server.server_port}")
    yield store, seen
    server.shutdown()


def test_pinecone_search_embeds_the_text_and_reranks(
    pinecone_server: tuple[PineconeStore, list[tuple[str, Any]]],
) -> None:
    store, seen = pinecone_server

    hits = store.search("docs", "What does the Pro plan cost?", 20, "bge-reranker-v2-m3", 8)

    assert hits == [Hit("doc_a_0", 0.91), Hit("doc_a_1", 0.12)]
    [(path, body)] = seen
    assert path == "/records/namespaces/docs/search"
    assert body == {
        "query": {"top_k": 20, "inputs": {"text": "What does the Pro plan cost?"}},
        "fields": ["file_id"],
        "rerank": {"model": "bge-reranker-v2-m3", "rank_fields": ["text"], "top_n": 8},
    }


def sse(*events: tuple[str, dict[str, Any]]) -> bytes:
    return "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events).encode()


def test_claude_streams_the_answer_with_the_expected_request() -> None:
    sent: dict[str, Any] = {}
    body = sse(
        (
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-opus-5-5",
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {
                        "input_tokens": 3000,
                        "output_tokens": 1,
                        "cache_read_input_tokens": 2400,
                    },
                },
            },
        ),
        (
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "Pro costs "},
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "$900 [1]."},
            },
        ),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                "usage": {"output_tokens": 12},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    )

    def handler(request: httpx2.Request) -> httpx2.Response:
        sent["url"] = str(request.url)
        sent["beta"] = request.headers.get("anthropic-beta")
        sent["body"] = json.loads(request.content)
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=body)

    client = anthropic.Anthropic(
        api_key="sk-ant-test", http_client=httpx2.Client(transport=httpx2.MockTransport(handler))
    )
    history = [{"role": "user", "content": "Earlier?"}, {"role": "assistant", "content": "Yes."}]
    stream = ClaudeAnswerer(client, "claude-opus-5-5", "claude-opus-5-5").stream(history, "PROMPT")  # type: ignore[arg-type]

    pieces: list[str] = []
    while True:
        try:
            pieces.append(next(stream))
        except StopIteration as finished:
            completion = finished.value
            break

    assert pieces == ["Pro costs ", "$900 [1]."]
    assert completion == Completion(
        "Pro costs $900 [1].", "end_turn", "claude-opus-5-5", 3000, 12, 2400
    )
    assert sent["url"] == "https://api.anthropic.com/v1/messages?beta=true"
    assert sent["beta"] == "server-side-fallback-2026-07-01"
    request = sent["body"]
    assert request["stream"] is True
    assert request["fallbacks"] == "default"
    assert request["output_config"] == {"effort": "medium"}
    assert request["max_tokens"] == 4000
    assert request["system"] == [
        {"type": "text", "text": ANSWER_SYSTEM, "cache_control": {"type": "ephemeral"}}
    ]
    assert request["messages"] == [*history, {"role": "user", "content": "PROMPT"}]
    assert "thinking" not in request and "temperature" not in request


def test_the_rewrite_request() -> None:
    sent: dict[str, Any] = {}

    def handler(request: httpx2.Request) -> httpx2.Response:
        sent.update(json.loads(request.content))
        return httpx2.Response(
            200,
            json={
                "id": "msg_2",
                "type": "message",
                "role": "assistant",
                "model": "claude-opus-5-5",
                "content": [{"type": "text", "text": "What does the Pro plan cost per year?"}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 200, "output_tokens": 12},
            },
        )

    client = anthropic.Anthropic(
        api_key="sk-ant-test", http_client=httpx2.Client(transport=httpx2.MockTransport(handler))
    )

    result = ClaudeAnswerer(client, "claude-opus-5-5", "claude-haiku-5-5").rewrite(
        "User: What does Pro cost?\nAssistant: $900 a month.", "and per year?"
    )

    assert result.text == "What does the Pro plan cost per year?"
    assert sent["model"] == "claude-haiku-5-5"
    assert sent["output_config"] == {"effort": "low"}
    assert sent["fallbacks"] == "default"
    assert sent["messages"][0]["content"].endswith("Follow-up question: and per year?")
