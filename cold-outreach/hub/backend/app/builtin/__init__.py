"""Built-in agents (SPEC step 25): agents whose code ships with the Hub and that the Hub's
`agents` service runs (`python -m app.runner`). Each is made on the Agents screen by choosing
its kind; there is no token to copy and nothing to start on the server.

A built-in agent talks to the Hub through the same agent API as any other agent, signed in
with a key the runner works out from SECRET_KEY (`runner_token`), which is never shown.
"""

import hashlib
import hmac
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.builtin import demo
from app.builtin.client import HubClient
from app.builtin.gbp import agent as gbp_audit
from app.config import get_settings

RUNNER_PREFIX = "hub_runner_"  # a marker; the signature after it is the secret


@dataclass(frozen=True)
class Kind:
    key: str
    name: str
    about: str
    # The job it does; None: chosen when the agent is added (the demo pretends any job).
    job: str | None
    manifest: dict[str, Any]
    run: Callable[[HubClient, dict[str, Any]], None]


KINDS: dict[str, Kind] = {
    "demo": Kind(
        key="demo",
        name="Demo agent",
        about="Pretends to do a job, so you can try batches, tasks and runs before the real "
        "agents are ready.",
        job=None,
        manifest=demo.MANIFEST,
        run=demo.do_run,
    ),
    "gbp-audit": Kind(
        key="gbp-audit",
        name="GBP audit agent",
        about="Collects each lead's Google Business Profile, posts and latest reviews from "
        "DataForSEO (about $0.01 a lead) and compares them with the batch's benchmark.",
        job="gbp-audit",
        manifest=gbp_audit.MANIFEST,
        run=gbp_audit.do_run,
    ),
}


def _signature(key: str) -> str:
    message = f"agent-runner:{key}".encode()
    return hmac.new(get_settings().signing_key, message, hashlib.sha256).hexdigest()


def runner_token(key: str) -> str:
    """How the runner signs in as the built-in agent `key`."""
    return f"{RUNNER_PREFIX}{key}.{_signature(key)}"


def key_of_runner_token(token: str) -> str | None:
    """The agent key a runner token is for, or None when it isn't a valid one."""
    if not token.startswith(RUNNER_PREFIX):
        return None
    key, _, signature = token[len(RUNNER_PREFIX) :].rpartition(".")
    if not key or not hmac.compare_digest(signature, _signature(key)):
        return None
    return key
