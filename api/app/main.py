import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Sprintboard AI service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("AI_CORS_ORIGIN", "http://localhost:5173")],
    allow_methods=["POST", "GET"],
    allow_headers=["authorization", "content-type"],
)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}
