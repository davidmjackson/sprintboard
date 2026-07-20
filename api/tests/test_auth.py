import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app import auth
from app.auth import require_user

_PRIV = ec.generate_private_key(ec.SECP256R1())


@pytest.fixture(autouse=True)
def _stub_signing_key(monkeypatch):
    # Production resolves the key from Supabase's JWKS; the test injects a known key.
    monkeypatch.setattr(auth, "_signing_key", lambda token: _PRIV.public_key())


def _mint(claims: dict) -> str:
    return jwt.encode(claims, _PRIV, algorithm="ES256")


def test_valid_token_returns_sub():
    token = _mint({"sub": "user-1", "aud": "authenticated", "exp": time.time() + 3600})
    assert auth.verify_bearer(token) == "user-1"


def test_expired_token_rejected():
    token = _mint({"sub": "user-1", "aud": "authenticated", "exp": time.time() - 1})
    with pytest.raises(Exception):
        auth.verify_bearer(token)


def test_wrong_audience_rejected():
    token = _mint({"sub": "user-1", "aud": "anon", "exp": time.time() + 3600})
    with pytest.raises(Exception):
        auth.verify_bearer(token)


# A probe app to exercise the header handling of the dependency.
_probe = FastAPI()


@_probe.get("/whoami")
def whoami(user_id: str = Depends(require_user)) -> dict:
    return {"user_id": user_id}


def test_missing_header_is_401():
    resp = TestClient(_probe).get("/whoami")
    assert resp.status_code == 401


def test_valid_header_is_200():
    token = _mint({"sub": "user-9", "aud": "authenticated", "exp": time.time() + 3600})
    resp = TestClient(_probe).get("/whoami", headers={"authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json() == {"user_id": "user-9"}
