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
