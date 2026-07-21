from fastapi import APIRouter, Depends, HTTPException

from . import estimation, llm, traceability
from .auth import require_user
from .llm import LLMError
from .schemas import DecomposeRequest, DecomposeResponse

router = APIRouter()


@router.post("/decompose", response_model=DecomposeResponse)
async def decompose(
    body: DecomposeRequest,
    user_id: str = Depends(require_user),
) -> DecomposeResponse:
    try:
        proposals = llm.propose(body.epic)
    except LLMError as exc:
        raise HTTPException(
            status_code=502, detail="The AI service returned an unusable response."
        ) from exc
    return estimation.analyze(traceability.analyze(body.epic.deliverables, proposals))
