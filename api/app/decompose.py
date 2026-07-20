from fastapi import APIRouter, Depends

from . import llm
from .auth import require_user
from .schemas import DecomposeRequest, DecomposeResponse

router = APIRouter()


@router.post("/decompose", response_model=DecomposeResponse)
async def decompose(
    body: DecomposeRequest,
    user_id: str = Depends(require_user),
) -> DecomposeResponse:
    proposals = llm.propose(body.epic)
    return DecomposeResponse(proposals=proposals)
