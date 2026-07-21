from fastapi.testclient import TestClient

from app import decompose as decompose_module
from app.auth import require_user
from app.llm import LLMError
from app.main import app
from app.schemas import Proposal

client = TestClient(app)

_CANNED = [
    Proposal(
        title="Build login form",
        description="…",
        type="story",
        rationale="Deliverable: auth UI",
        covers=[0],
        estimate=5,
        estimate_reason="a form with validation",
    ),
    Proposal(
        title="Fix token refresh",
        description="…",
        type="bug",
        rationale="Context: sessions expire",
        covers=[],
        estimate=7,
        estimate_reason="unclear repro",
    ),
]


def _override_auth():
    app.dependency_overrides[require_user] = lambda: "user-1"


def teardown_function():
    app.dependency_overrides.clear()


def test_decompose_returns_proposals(monkeypatch):
    _override_auth()
    monkeypatch.setattr(decompose_module.llm, "propose", lambda epic: _CANNED)
    resp = client.post(
        "/decompose",
        json={"epic": {"summary": "Auth", "context": "c", "deliverables": ["auth UI"]}},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert [p["title"] for p in body["proposals"]] == ["Build login form", "Fix token refresh"]
    assert body["proposals"][0]["type"] == "story"


def test_bad_body_is_422(monkeypatch):
    _override_auth()
    monkeypatch.setattr(decompose_module.llm, "propose", lambda epic: _CANNED)
    resp = client.post("/decompose", json={"not_epic": True})
    assert resp.status_code == 422


def test_llm_error_is_502(monkeypatch):
    _override_auth()

    def _raise(epic):
        raise LLMError("boom")

    monkeypatch.setattr(decompose_module.llm, "propose", _raise)
    resp = client.post(
        "/decompose",
        json={"epic": {"summary": "Auth", "context": "c", "deliverables": ["auth UI"]}},
    )
    assert resp.status_code == 502


def test_decompose_requires_auth():
    resp = client.post(
        "/decompose",
        json={"epic": {"summary": "Auth", "context": "c", "deliverables": ["auth UI"]}},
    )
    assert resp.status_code == 401


def test_decompose_includes_coverage_analysis(monkeypatch):
    _override_auth()
    monkeypatch.setattr(decompose_module.llm, "propose", lambda epic: _CANNED)
    resp = client.post(
        "/decompose",
        json={
            "epic": {
                "summary": "Auth",
                "context": "c",
                "deliverables": ["auth UI", "token refresh"],
            }
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["proposals"][0]["covers"] == [0]
    assert body["coverage_gaps"] == [{"index": 1, "deliverable": "token refresh"}]
    assert body["scope_creep"] == [{"proposal_index": 1, "title": "Fix token refresh"}]


def test_decompose_includes_estimates_and_total(monkeypatch):
    _override_auth()
    monkeypatch.setattr(decompose_module.llm, "propose", lambda epic: _CANNED)
    resp = client.post(
        "/decompose",
        json={"epic": {"summary": "Auth", "context": "c", "deliverables": ["auth UI"]}},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["proposals"][0]["estimate"] == 5
    assert body["proposals"][0]["estimate_reason"] == "a form with validation"
    assert body["proposals"][1]["estimate"] == 8  # 7 snapped up to 8
    assert body["estimate_total"] == 13  # 5 + 8
