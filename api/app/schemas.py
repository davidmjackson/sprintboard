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
    covers: list[int] = []  # 0-based indices of the epic's deliverables this item serves


class CoverageGap(BaseModel):
    index: int
    deliverable: str


class ScopeCreep(BaseModel):
    proposal_index: int
    title: str


class DecomposeRequest(BaseModel):
    epic: EpicIn


class DecomposeResponse(BaseModel):
    proposals: list[Proposal]
    coverage_gaps: list[CoverageGap] = []
    scope_creep: list[ScopeCreep] = []
