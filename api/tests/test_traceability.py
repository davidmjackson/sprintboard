from app.schemas import Proposal
from app.traceability import analyze


def _p(title, covers):
    return Proposal(title=title, description="d", type="story", rationale="r", covers=covers)


def test_full_coverage_has_no_gaps_or_creep():
    result = analyze(["a", "b"], [_p("x", [0]), _p("y", [1])])
    assert result.coverage_gaps == []
    assert result.scope_creep == []


def test_uncovered_deliverable_is_a_gap():
    result = analyze(["a", "b"], [_p("x", [0])])
    assert [(g.index, g.deliverable) for g in result.coverage_gaps] == [(1, "b")]
    assert result.scope_creep == []


def test_proposal_covering_nothing_is_creep():
    result = analyze(["a"], [_p("x", [0]), _p("y", [])])
    assert [(c.proposal_index, c.title) for c in result.scope_creep] == [(1, "y")]
    assert result.coverage_gaps == []


def test_out_of_range_index_is_dropped_and_can_become_creep():
    result = analyze(["a"], [_p("x", [5])])
    assert result.proposals[0].covers == []
    assert [c.proposal_index for c in result.scope_creep] == [0]
    assert [g.index for g in result.coverage_gaps] == [0]


def test_covers_is_deduped_and_sorted():
    result = analyze(["a", "b"], [_p("x", [1, 0, 1])])
    assert result.proposals[0].covers == [0, 1]


def test_zero_deliverables_is_vacuous():
    result = analyze([], [_p("x", []), _p("y", [3])])
    assert result.coverage_gaps == []
    assert result.scope_creep == []
    assert result.proposals[1].covers == []
