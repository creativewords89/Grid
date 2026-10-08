"""Claude calls for answering: the follow-up rewrite and the streamed answer (SPEC 9.1-9.2)."""

from collections.abc import Generator
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol

import anthropic
from anthropic.types.beta import BetaMessageParam, BetaTextBlockParam

from app.ai.ocr_client import FALLBACK_BETA
from app.answering.prompts import ANSWER_SYSTEM, REWRITE_SYSTEM
from app.config import get_settings

ANSWER_MAX_TOKENS = 4000
REWRITE_MAX_TOKENS = 300


@dataclass(frozen=True)
class Completion:
    text: str
    stop_reason: str | None
    model: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int = 0


class Answerer(Protocol):
    def rewrite(self, transcript: str, question: str) -> Completion: ...
    def stream(
        self, history: list[BetaMessageParam], prompt: str
    ) -> Generator[str, None, Completion]: ...


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
    def __init__(self, client: anthropic.Anthropic, answer_model: str, rewrite_model: str) -> None:
        self.client = client
        self.answer_model = answer_model
        self.rewrite_model = rewrite_model

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
            output_config={"effort": "medium"},
            system=system,
            messages=[*history, {"role": "user", "content": prompt}],
        ) as stream:
            yield from stream.text_stream
            return _completion(stream.get_final_message())


@lru_cache
def _client(api_key: str) -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=api_key, max_retries=2, timeout=120.0)


def get_answerer() -> Answerer | None:
    settings = get_settings()
    if not settings.anthropic_api_key:
        return None
    return ClaudeAnswerer(
        _client(settings.anthropic_api_key), settings.answer_model, settings.rewrite_model
    )
