import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .decompose import router as decompose_router

app = FastAPI(title="Sprintboard AI service")

app.include_router(decompose_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("AI_CORS_ORIGIN", "http://localhost:5173")],
    allow_methods=["POST", "GET"],
    allow_headers=["authorization", "content-type"],
)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}
