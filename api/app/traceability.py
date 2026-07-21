from .schemas import CoverageGap, DecomposeResponse, Proposal, ScopeCreep


def _sanitise(covers: list[int], deliverable_count: int) -> list[int]:
    """Keep only in-range indices, de-duplicated and sorted. An out-of-range index (the
    model hallucinated one) is silently dropped; if that empties the list the proposal
    correctly reads as scope-creep."""
    return sorted({i for i in covers if 0 <= i < deliverable_count})


def analyze(deliverables: list[str], proposals: list[Proposal]) -> DecomposeResponse:
    """Derive coverage-gap and scope-creep from the model's proposal->deliverable mapping.

    Pure and deterministic — the analysis is a function of the mapping, never a second
    opinion from the model. With no deliverables the analysis is vacuous: there is nothing
    to trace to, so no gaps and no creep (flagging every proposal would be pure noise)."""
    count = len(deliverables)
    sanitised = [p.model_copy(update={"covers": _sanitise(p.covers, count)}) for p in proposals]

    if count == 0:
        return DecomposeResponse(proposals=sanitised, coverage_gaps=[], scope_creep=[])

    covered = {i for p in sanitised for i in p.covers}
    coverage_gaps = [
        CoverageGap(index=i, deliverable=deliverables[i]) for i in range(count) if i not in covered
    ]
    scope_creep = [
        ScopeCreep(proposal_index=n, title=p.title) for n, p in enumerate(sanitised) if not p.covers
    ]
    return DecomposeResponse(
        proposals=sanitised, coverage_gaps=coverage_gaps, scope_creep=scope_creep
    )
