"""Claude calls for answering: the follow-up rewrite, the streamed answer and the support
check (SPEC 9.1-9.3)."""

import json
import logging
from collections.abc import Generator
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Literal, Protocol

import anthropic
from anthropic.types.beta import BetaMessageParam, BetaTextBlockParam
from sqlalchemy.orm import Session

from app import connections, settings_store
from app.ai.ocr_client import FALLBACK_BETA
from app.answering.prompts import (
    ANSWER_SYSTEM,
    CHECK_SCHEMA,
    CHECK_SYSTEM,
    DRAFT_SYSTEM,
    REWRITE_SYSTEM,
    VOICE_GUIDE_SYSTEM,
)

log = logging.getLogger(__name__)

ANSWER_MAX_TOKENS = 4000
REWRITE_MAX_TOKENS = 300
CHECK_MAX_TOKENS = 2000
DRAFT_MAX_TOKENS = 1500

Effort = Literal["low", "medium", "high", "xhigh", "max"]
EFFORTS: tuple[Effort, ...] = ("low", "medium", "high", "xhigh", "max")


@dataclass(frozen=True)
class Completion:
    text: str
    stop_reason: str | None
    model: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int = 0


@dataclass(frozen=True)
class CheckResult:
    """The support check's verdict; None when Claude declined or the reply wasn't usable."""

    verdict: str | None
    unsupported_claims: list[str]
    completion: Completion


class Answerer(Protocol):
    def rewrite(self, transcript: str, question: str) -> Completion: ...
    def stream(
        self, history: list[BetaMessageParam], prompt: str
    ) -> Generator[str, None, Completion]: ...
    def check(self, prompt: str) -> CheckResult: ...
    def draft(self, prompt: str) -> Completion: ...
    def voice_guide(self, prompt: str) -> Completion: ...


def parse_check(completion: Completion) -> CheckResult:
    if completion.stop_reason != "end_turn":
        return CheckResult(None, [], completion)
    try:
        data = json.loads(completion.text)
        verdict = data["verdict"]
        claims = [str(claim) for claim in data.get("unsupported_claims", [])]
    except (ValueError, KeyError, TypeError):
        log.warning("the support check returned something that isn't the expected JSON")
        return CheckResult(None, [], completion)
    if verdict not in ("full", "partial", "none"):
        return CheckResult(None, [], completion)
    return CheckResult(verdict, claims, completion)


def _completion(message: Any) -> Completion:
    usage = message.usage
    text = "".join(block.text for block in message.content if block.type == "text").strip()
    return Completion(
        text=text,
        stop_reason=message.stop_reason,
        model=message.model,
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        cache_read_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
    )


class ClaudeAnswerer:
    def __init__(
        self,
        client: anthropic.Anthropic,
        answer_model: str,
        rewrite_model: str,
        check_model: str = "claude-opus-5-5",
        effort: Effort = "medium",
    ) -> None:
        self.client = client
        self.answer_model = answer_model
        self.rewrite_model = rewrite_model
        self.check_model = check_model
        self.effort = effort

    def rewrite(self, transcript: str, question: str) -> Completion:
        message = self.client.beta.messages.create(
            model=self.rewrite_model,
            max_tokens=REWRITE_MAX_TOKENS,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            output_config={"effort": "low"},
            system=REWRITE_SYSTEM,
            messages=[
                {
                    "role": "user",
                    "content": f"<chat>\n{transcript}\n</chat>\n\nFollow-up question: {question}",
                }
            ],
        )
        return _completion(message)

    def stream(
        self, history: list[BetaMessageParam], prompt: str
    ) -> Generator[str, None, Completion]:
        system: list[BetaTextBlockParam] = [
            {"type": "text", "text": ANSWER_SYSTEM, "cache_control": {"type": "ephemeral"}}
        ]
        with self.client.beta.messages.stream(
            model=self.answer_model,
            max_tokens=ANSWER_MAX_TOKENS,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            output_config={"effort": self.effort},
            system=system,
            messages=[*history, {"role": "user", "content": prompt}],
        ) as stream:
            yield from stream.text_stream
            return _completion(stream.get_final_message())

    def check(self, prompt: str) -> CheckResult:
        """Does the context support the answer? Structured output (SPEC 9.3)."""
        message = self.client.beta.messages.create(
            model=self.check_model,
            max_tokens=CHECK_MAX_TOKENS,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            output_config={
                "effort": "low",
                "format": {"type": "json_schema", "schema": CHECK_SCHEMA},
            },
            system=CHECK_SYSTEM,
            messages=[{"role": "user", "content": prompt}],
        )
        return parse_check(_completion(message))

    def draft(self, prompt: str) -> Completion:
        """A marketing reply (SPEC 6.10). Not streamed: drafts are short."""
        system: list[BetaTextBlockParam] = [
            {"type": "text", "text": DRAFT_SYSTEM, "cache_control": {"type": "ephemeral"}}
        ]
        message = self.client.beta.messages.create(
            model=self.answer_model,
            max_tokens=DRAFT_MAX_TOKENS,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            output_config={"effort": self.effort},
            system=system,
            messages=[{"role": "user", "content": prompt}],
        )
        return _completion(message)

    def voice_guide(self, prompt: str) -> Completion:
        """A platform's brand-voice style guide, written from its examples (SPEC 6.13)."""
        message = self.client.beta.messages.create(
            model=self.answer_model,
            max_tokens=DRAFT_MAX_TOKENS,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            output_config={"effort": self.effort},
            system=[{"type": "text", "text": VOICE_GUIDE_SYSTEM}],
            messages=[{"role": "user", "content": prompt}],
        )
        return _completion(message)


@lru_cache
def _client(api_key: str) -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=api_key, max_retries=2, timeout=120.0)


def get_answerer(db: Session | None = None) -> Answerer | None:
    """Claude for answering, or None without an API key. The Owner can choose other models
    and the answer effort in Settings (SPEC 7.8); otherwise the .env models apply."""
    settings = connections.current()
    if not settings.anthropic_api_key:
        return None

    def pick(key: str, default: str) -> str:
        chosen = settings_store.get(db, key) if db is not None else None
        return str(chosen) if chosen else default

    return ClaudeAnswerer(
        _client(settings.anthropic_api_key),
        pick("answer_model", settings.answer_model),
        pick("rewrite_model", settings.rewrite_model),
        pick("check_model", settings.check_model),
        _effort(pick("answer_effort", "medium")),
    )


def _effort(value: str) -> Effort:
    for effort in EFFORTS:
        if value == effort:
            return effort
    return "medium"
