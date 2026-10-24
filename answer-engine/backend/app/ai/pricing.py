"""Claude prices in US dollars per million tokens (SPEC section 9.5), for cost tracking.

Update these when Anthropic's prices change. A model missing here is costed at 0 and logged.
"""

import logging

log = logging.getLogger(__name__)

PER_MILLION: dict[str, tuple[float, float]] = {  # model: (input, output)
    "claude-opus-5-5": (4.00, 20.00),
    "claude-opus-5": (5.00, 25.00),
    "claude-opus-4-8": (5.00, 25.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),
}


def cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    prices = PER_MILLION.get(model)
    if prices is None:
        log.warning("no price for model %s; its usage is costed at $0", model)
        return 0.0
    return (input_tokens * prices[0] + output_tokens * prices[1]) / 1_000_000
