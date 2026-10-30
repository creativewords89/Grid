"""The GBP description checked by Claude (`agents/gbp-audit/SPEC.md` section 5): does it name
the business, its primary category, its city, and which of the niche's main services?

Claude answers in a fixed JSON shape, quoting the description's own words for each yes; a
yes whose quote isn't in the description is taken as no. Without a description, a key or a
usable answer nothing is checked ("unable to verify", never a problem).
"""

import json
import logging
import re
from typing import Any

import anthropic

log = logging.getLogger("gbp-audit")

MODELS = ("claude-opus-5-5", "claude-haiku-5-5")
FALLBACK_MODELS = ("claude-opus-5-5",)  # a refused request is re-run on a fallback model
FALLBACK_BETA = "server-side-fallback-2026-07-01"

base_url: str | None = None  # tests point the client at a fake

SYSTEM = (
    "You check a Google Business Profile description for a local marketing audit. Answer "
    "only from the description's text. For each question, say whether the description "
    "mentions it, and when it does, copy the exact words from the description that show "
    'it (a short phrase, character for character). A close wording counts ("construction '
    'services" mentions the category "Construction company"); a guess does not.'
)

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "brand": {"$ref": "#/$defs/answer"},
        "category": {"$ref": "#/$defs/answer"},
        "city": {"$ref": "#/$defs/answer"},
        "services": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "service": {"type": "string"},
                    "mentioned": {"type": "boolean"},
                    "quote": {"type": "string"},
                },
                "required": ["service", "mentioned", "quote"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["brand", "category", "city", "services"],
    "additionalProperties": False,
    "$defs": {
        "answer": {
            "type": "object",
            "properties": {"mentioned": {"type": "boolean"}, "quote": {"type": "string"}},
            "required": ["mentioned", "quote"],
            "additionalProperties": False,
        }
    },
}


def _plain(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def _brand(name: str) -> str:
    """The business's name without "LLC", "Inc." and the like."""
    return re.sub(r"[,\s]+(llc|inc\.?|co\.?|corp\.?|ltd\.?)$", "", name.strip(), flags=re.I)


def prompt(
    description: str, name: str, category: str, city: str, services: list[dict[str, Any]]
) -> str:
    listed = "\n".join(
        f"- {s['name']}"
        + (f" (also called: {', '.join(s['synonyms'])})" if s.get("synonyms") else "")
        for s in services
    )
    return (
        f"<description>\n{description}\n</description>\n\n"
        f'brand: does it name the business "{_brand(name)}"?\n'
        f'category: does it say what the business is, its primary category "{category}"?\n'
        f'city: does it name the city "{city}"?\n'
        "services: for each service below, is it mentioned (by any of its names)? Answer "
        "every service, with its name as listed.\n"
        f"{listed or '(none)'}"
    )


def _checked(answer: Any, description: str) -> dict[str, Any] | None:
    """An answer whose quote is really in the description; a yes without one is a no."""
    if not isinstance(answer, dict) or not isinstance(answer.get("mentioned"), bool):
        return None
    quote = str(answer.get("quote") or "").strip()
    found = bool(answer["mentioned"]) and bool(quote) and _plain(quote) in _plain(description)
    return {"mentioned": found, "quote": quote if found else None}


def check(
    key: str,
    model: str,
    description: str,
    name: str,
    category: str,
    city: str,
    services: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """What the description mentions, or None when Claude couldn't be asked or answered
    unusably."""
    if not key or not description.strip() or model not in MODELS:
        return None
    client = anthropic.Anthropic(api_key=key, base_url=base_url, max_retries=2, timeout=120.0)
    request: dict[str, Any] = {
        "model": model,
        "max_tokens": 4000,
        "system": SYSTEM,
        "messages": [
            {"role": "user", "content": prompt(description, name, category, city, services)}
        ],
        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
    }
    try:
        if model in FALLBACK_MODELS:
            response: Any = client.beta.messages.create(
                **request, betas=[FALLBACK_BETA], fallbacks="default"
            )
        else:
            response = client.messages.create(**request)
    except anthropic.AuthenticationError:
        log.warning("Claude refused the API key")
        return None
    except anthropic.APIStatusError as error:
        log.warning("Claude answered %s: %s", error.status_code, error.message)
        return None
    except anthropic.APIConnectionError:
        log.warning("Claude can't be reached")
        return None
    if response.stop_reason in ("refusal", "max_tokens"):
        log.warning("Claude stopped: %s", response.stop_reason)
        return None
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        raw = json.loads(text)
    except ValueError:
        return None
    answers = {part: _checked(raw.get(part), description) for part in ("brand", "category", "city")}
    by_name = {
        str(s.get("service", "")).strip().lower(): s
        for s in raw.get("services") or []
        if isinstance(s, dict)
    }
    listed = []
    for service in services:
        answer = _checked(by_name.get(service["name"].strip().lower()), description)
        listed.append(
            {
                "name": service["name"],
                "mentioned": bool(answer and answer["mentioned"]),
                "quote": answer["quote"] if answer else None,
            }
        )
    return {"model": model, **answers, "services": listed}
