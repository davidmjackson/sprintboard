import json

import anthropic
import pytest
from app import llm
from app.llm import LLMError
from app.schemas import EpicIn

_EPIC = EpicIn(summary="s", context="c", deliverables=["d"])


class _FakeAPIError(anthropic.APIError):
    def __init__(self):  # bypass the real (version-specific) signature
        pass


def test_api_error_becomes_llmerror(monkeypatch):
    class _Client:
        class messages:
            @staticmethod
            def create(**kw):
                raise _FakeAPIError()

    monkeypatch.setattr(llm, "Anthropic", lambda *a, **k: _Client())
    with pytest.raises(LLMError):
        llm.propose(_EPIC)


def test_missing_text_block_becomes_llmerror(monkeypatch):
    class _Resp:
        content = []  # no text block -> StopIteration in the genexpr

    class _Client:
        class messages:
            @staticmethod
            def create(**kw):
                return _Resp()

    monkeypatch.setattr(llm, "Anthropic", lambda *a, **k: _Client())
    with pytest.raises(LLMError):
        llm.propose(_EPIC)


def test_schema_requires_covers():
    items = llm.PROPOSALS_SCHEMA["properties"]["proposals"]["items"]
    assert "covers" in items["properties"]
    assert "covers" in items["required"]


def test_schema_requires_estimate_fields():
    items = llm.PROPOSALS_SCHEMA["properties"]["proposals"]["items"]
    assert "estimate" in items["properties"]
    assert "estimate_reason" in items["properties"]
    assert "estimate" in items["required"]
    assert "estimate_reason" in items["required"]


def test_response_with_covers_parses(monkeypatch):
    payload = {
        "proposals": [
            {
                "title": "t",
                "description": "d",
                "type": "story",
                "rationale": "r",
                "covers": [0],
                "estimate": 5,
                "estimate_reason": "moderate scope",
            }
        ]
    }

    class _Block:
        type = "text"
        text = json.dumps(payload)

    class _Resp:
        content = [_Block()]

    class _Client:
        class messages:
            @staticmethod
            def create(**kw):
                return _Resp()

    monkeypatch.setattr(llm, "Anthropic", lambda *a, **k: _Client())
    result = llm.propose(_EPIC)
    assert result[0].covers == [0]
    assert result[0].estimate == 5
    assert result[0].estimate_reason == "moderate scope"
