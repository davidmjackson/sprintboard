import json
import os

from anthropic import Anthropic
from pydantic import ValidationError

from .schemas import EpicIn, Proposal


class LLMError(Exception):
    """The model returned a response we could not turn into proposals."""

_MODEL = os.environ.get("AI_MODEL", "claude-opus-4-8")

_SYSTEM = (
    "You are a Scrum delivery assistant. Given an epic's context and deliverables, "
    "propose the child work items needed to deliver it. Each item is a story, bug, or "
    "task — never an epic. Prefer one item per deliverable where sensible; keep titles "
    "short and imperative. For each item, give a one-line rationale naming the "
    "deliverable or part of the context it serves."
)

# Structured-output schema: every object needs additionalProperties:false + required;
# no minLength/maxLength/numeric constraints are allowed.
PROPOSALS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "proposals": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "type": {"type": "string", "enum": ["story", "bug", "task"]},
                    "rationale": {"type": "string"},
                },
                "required": ["title", "description", "type", "rationale"],
            },
        }
    },
    "required": ["proposals"],
}


def propose(epic: EpicIn) -> list[Proposal]:
    """Ask Claude to decompose the epic. This is the single seam tests mock — CI never
    reaches this code, so it makes no network call and needs no ANTHROPIC_API_KEY."""
    client = Anthropic()  # reads ANTHROPIC_API_KEY from the environment
    deliverables = "\n".join(f"- {d}" for d in epic.deliverables) or "(none listed)"
    user = f"Epic: {epic.summary}\n\nContext:\n{epic.context}\n\nDeliverables:\n{deliverables}"

    resp = client.messages.create(
        model=_MODEL,
        max_tokens=4096,
        thinking={"type": "adaptive"},
        output_config={"format": {"type": "json_schema", "schema": PROPOSALS_SCHEMA}},
        system=_SYSTEM,
        messages=[{"role": "user", "content": user}],
    )
    try:
        text = next(block.text for block in resp.content if block.type == "text")
        data = json.loads(text)
        return [Proposal(**item) for item in data["proposals"]]
    except (StopIteration, json.JSONDecodeError, KeyError, TypeError, ValidationError) as exc:
        raise LLMError("Claude returned a response we could not parse into proposals") from exc
