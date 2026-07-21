from .schemas import DecomposeResponse

ALLOWED_POINTS: tuple[int, ...] = (1, 2, 3, 5, 8, 13)  # modified Fibonacci Scrum scale


def _snap(value: int) -> int:
    """Snap an estimate onto ALLOWED_POINTS: nearest by absolute distance, ties resolve to
    the smaller size. A model that emits 0, 7, or 100 is corrected here so the UI never
    shows an off-scale Scrum size."""
    return min(ALLOWED_POINTS, key=lambda point: (abs(point - value), point))


def analyze(response: DecomposeResponse) -> DecomposeResponse:
    """Validate every proposal's estimate onto the scale and derive estimate_total as the
    deterministic sum of the snapped estimates. Pure — the total is a function of the parts,
    never a second number from the model."""
    snapped = [p.model_copy(update={"estimate": _snap(p.estimate)}) for p in response.proposals]
    total = sum(p.estimate for p in snapped)
    return response.model_copy(update={"proposals": snapped, "estimate_total": total})
