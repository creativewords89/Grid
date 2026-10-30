"""The agent API as a built-in agent calls it (SPEC section 6.2), over HTTP like any agent."""

import json
import urllib.error
import urllib.request
import uuid
from typing import Any


class HubClient:
    def __init__(self, url: str, token: str) -> None:
        self.base = url.rstrip("/") + "/api/agent/v1"
        self.token = token

    def call(self, method: str, path: str, body: Any = None) -> tuple[int, Any]:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(  # noqa: S310  (the Hub's own address)
            self.base + path,
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
                text = response.read().decode()
                return response.status, json.loads(text) if text else None
        except urllib.error.HTTPError as error:
            text = error.read().decode()
            return error.code, json.loads(text) if text else None

    def upload(self, path: str, name: str, content: bytes, content_type: str) -> int:
        """Save a report file for a lead (POST /leads/{id}/files, multipart)."""
        boundary = f"hub-{uuid.uuid4().hex}"
        body = (
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n{name}\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                f'filename="{name}"\r\nContent-Type: {content_type}\r\n\r\n'
            ).encode()
            + content
            + f"\r\n--{boundary}--\r\n".encode()
        )
        request = urllib.request.Request(  # noqa: S310  (the Hub's own address)
            self.base + path,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
                return int(response.status)
        except urllib.error.HTTPError as error:
            return int(error.code)
