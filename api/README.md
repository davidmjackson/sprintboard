# Sprintboard AI service (Rung 2, R2.0)

Local, stateless FastAPI service for AI epic decomposition. It verifies the caller's
Supabase JWT, calls Claude, and returns proposed child stories. It touches no database.

## Run locally

    cd api
    python -m venv .venv
    .venv/bin/pip install -r requirements-dev.txt
    # from repo-root .env.local (server-side, NOT VITE_-prefixed):
    #   ANTHROPIC_API_KEY=...        # the model key
    #   SUPABASE_URL=https://<ref>.supabase.co
    set -a; . ../.env.local; set +a
    .venv/bin/uvicorn app.main:app --port 8787 --reload

## Test (model mocked, no key or network)

    cd api && .venv/bin/python -m pytest -q

## Lint

    cd api && .venv/bin/ruff check .
