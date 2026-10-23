"""A stand-in for the Claude API, for the end-to-end tests (no key, no cost).

- Answers (streamed) cite the first and last document they are given.
- The support check says "partial" when the question contains "long" (so the answer goes
  to review), unless a team-verified answer was given; otherwise "full".
- Marketing drafts are a fixed helpful reply; "mention us" in the prompt adds GridRankers.
- Follow-up rewrites prefix the question.
"""

import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


def sse(name: str, data: dict[str, Any]) -> bytes:
    return f"event: {name}\ndata: {json.dumps(data)}\n\n".encode()


def message(model: str, text: str, tokens_in: int, tokens_out: int) -> dict[str, Any]:
    return {
        "id": "msg_fake",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": tokens_in, "output_tokens": tokens_out},
    }


def text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    return " ".join(block.get("text", "") for block in content)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if body.get("stream"):
            return self.stream(body)
        model = body["model"]
        prompt = text_of(body["messages"][0]["content"])
        system = json.dumps(body.get("system"))
        if (body.get("output_config") or {}).get("format"):
            if "You grade answers" in system:
                return self.json(
                    message(model, json.dumps({"verdict": "correct", "reason": "ok"}), 600, 40)
                )
            long_q = "long" in prompt.lower() and 'verified="true"' not in prompt
            verdict = "partial" if long_q else "full"
            claims = ["takes 3 weeks"] if long_q else []
            out = json.dumps({"verdict": verdict, "unsupported_claims": claims})
            return self.json(message(model, out, 2100, 30))
        if "You draft replies" in system:
            text = (
                "Verification usually takes 5 to 14 days by postcard or video. Keep your name, "
                "address and phone exactly the same everywhere while you wait."
            )
            if "mention us" in prompt.lower():
                text += " We see this a lot at GridRankers."
            return self.json(message(model, text, 2600, 60))
        question = prompt.split("Follow-up question:")[-1].strip()
        return self.json(message(model, "Client handbook " + question, 200, 20))

    def stream(self, body: dict[str, Any]) -> None:
        prompt = text_of(body["messages"][-1]["content"])
        docs = re.findall(r'<document index="(\d+)" source="([^"]*)"', prompt)
        if not docs:
            text = "I couldn't find this in the knowledge base."
        else:
            n, source = docs[0]
            text = (
                f"According to **{source}**, here is what the handbook says [{n}].\n\n"
                f"- First point from the documents [{n}]\n- Second point [{docs[-1][0]}]"
            )
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        start = {
            "id": "msg_fake",
            "type": "message",
            "role": "assistant",
            "model": body["model"],
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 2500, "output_tokens": 1, "cache_read_input_tokens": 1800},
        }
        self.wfile.write(sse("message_start", {"type": "message_start", "message": start}))
        block = {"type": "text", "text": ""}
        self.wfile.write(
            sse(
                "content_block_start",
                {"type": "content_block_start", "index": 0, "content_block": block},
            )
        )
        for piece in re.findall(r"\S+\s*", text):
            delta = {"type": "text_delta", "text": piece}
            self.wfile.write(
                sse(
                    "content_block_delta",
                    {"type": "content_block_delta", "index": 0, "delta": delta},
                )
            )
            self.wfile.flush()
            time.sleep(0.03)
        self.wfile.write(sse("content_block_stop", {"type": "content_block_stop", "index": 0}))
        done = {"stop_reason": "end_turn", "stop_sequence": None}
        self.wfile.write(
            sse(
                "message_delta",
                {"type": "message_delta", "delta": done, "usage": {"output_tokens": 60}},
            )
        )
        self.wfile.write(sse("message_stop", {"type": "message_stop"}))
        self.wfile.flush()

    def json(self, out: dict[str, Any]) -> None:
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args: Any) -> None:
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
