import os

import jwt
from fastapi import Header, HTTPException

_SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
_JWKS_URL = f"{_SUPABASE_URL}/auth/v1/.well-known/jwks.json"
_ALGORITHMS = ["ES256", "RS256"]

# Built only when configured, so importing this module never requires the env.
_jwks_client = jwt.PyJWKClient(_JWKS_URL) if _SUPABASE_URL else None


def _signing_key(token: str):
    """Resolve the signing key from Supabase's JWKS. Monkeypatched in tests."""
    if _jwks_client is None:
        raise RuntimeError("SUPABASE_URL is not configured")
    return _jwks_client.get_signing_key_from_jwt(token).key


def verify_bearer(token: str) -> str:
    key = _signing_key(token)
    claims = jwt.decode(
        token,
        key,
        algorithms=_ALGORITHMS,
        audience="authenticated",
        options={"require": ["exp", "sub"]},
    )
    return claims["sub"]


async def require_user(authorization: str = Header(default="")) -> str:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    try:
        return verify_bearer(authorization[len("Bearer ") :])
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="invalid token")
