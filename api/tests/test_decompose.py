from fastapi.testclient import TestClient

from app import decompose as decompose_module
from app.auth import require_user
from app.main import app
from app.schemas import Proposal

client = TestClient(app)

_CANNED = [
    Proposal(title="Build login form", description="…", type="story", rationale="Deliverable: auth UI"),
    Proposal(title="Fix token refresh", description="…", type="bug", rationale="Context: sessions expire"),
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
