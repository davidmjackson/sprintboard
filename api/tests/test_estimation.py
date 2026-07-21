import pytest

from app.estimation import ALLOWED_POINTS, _snap, analyze
from app.schemas import DecomposeResponse, Proposal


def _proposal(estimate: int, title: str = "Item") -> Proposal:
    return Proposal(
        title=title, description="d", type="story", rationale="r", covers=[], estimate=estimate
    )


@pytest.mark.parametrize(
    "value,expected",
    [(1, 1), (0, 1), (-5, 1), (2, 2), (4, 3), (6, 5), (7, 8), (12, 13), (13, 13), (100, 13)],
)
def test_snap_onto_scale(value, expected):
    assert _snap(value) == expected


def test_snap_only_returns_allowed_points():
    assert all(_snap(v) in ALLOWED_POINTS for v in range(-10, 40))


def test_analyze_snaps_and_totals_on_scale_values():
    out = analyze(DecomposeResponse(proposals=[_proposal(3), _proposal(5)]))
    assert [p.estimate for p in out.proposals] == [3, 5]
    assert out.estimate_total == 8


def test_analyze_snaps_off_scale_before_summing():
    out = analyze(DecomposeResponse(proposals=[_proposal(7), _proposal(100)]))
    assert [p.estimate for p in out.proposals] == [8, 13]
    assert out.estimate_total == 21


def test_analyze_empty_proposals_totals_zero():
    assert analyze(DecomposeResponse(proposals=[])).estimate_total == 0


def test_analyze_preserves_traceability_fields():
    out = analyze(
        DecomposeResponse(
            proposals=[_proposal(3)],
            coverage_gaps=[],
            scope_creep=[],
        )
    )
    assert out.coverage_gaps == []
    assert out.scope_creep == []
