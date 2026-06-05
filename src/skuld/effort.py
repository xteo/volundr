"""Reasoning-effort levels shared across config, broker, and transports.

`effort` is the Anthropic `effort` parameter (Claude Opus 4.6+/Sonnet 4.6+):
``low | medium | high | max`` — higher spends more thinking. Codex uses
``reasoning_effort`` with the same low/medium/high tiers (no ``max``), so we map
``max`` down to ``high`` for Codex.
"""

from __future__ import annotations

#: Valid effort levels, lowest -> highest. ``max`` is the most thinking.
EFFORT_LEVELS: tuple[str, ...] = ("low", "medium", "high", "max")

#: Default for a new session — think hardest unless the caller opts down.
DEFAULT_EFFORT = "max"


def normalize_effort(value: object) -> str:
    """Coerce arbitrary input to a valid effort level (default ``max``).

    Accepts any case / surrounding whitespace; an unrecognized value falls back
    to :data:`DEFAULT_EFFORT` so a bad input never breaks session start.
    """
    if not isinstance(value, str):
        return DEFAULT_EFFORT
    v = value.strip().lower()
    return v if v in EFFORT_LEVELS else DEFAULT_EFFORT


def codex_reasoning_effort(effort: object) -> str:
    """Map an effort level onto Codex ``reasoning_effort`` (no ``max`` tier)."""
    v = normalize_effort(effort)
    return "high" if v == "max" else v
