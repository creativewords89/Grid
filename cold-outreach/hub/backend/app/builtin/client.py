"""The agent API as a built-in agent calls it (SPEC section 6.2), over HTTP like any agent."""

import json
import urllib.error
import urllib.request
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
