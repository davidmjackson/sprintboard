from typing import Literal

from pydantic import BaseModel


class EpicIn(BaseModel):
    summary: str
    context: str = ""
    deliverables: list[str] = []


class Proposal(BaseModel):
    title: str
    description: str
    type: Literal["story", "bug", "task"]
    rationale: str


class DecomposeRequest(BaseModel):
    epic: EpicIn


class DecomposeResponse(BaseModel):
    proposals: list[Proposal]
