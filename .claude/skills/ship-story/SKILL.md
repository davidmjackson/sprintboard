---
name: ship-story
description: Use when a Sprintboard story's implementation is finished and its acceptance criteria are met — closing it out by verifying, committing, opening the PR, moving the Jira issue to In Review, and dispatching background peer and security reviews. Also use when the user says "ship it", "close out this story", or "/ship-story SPRIN-N".
---

# Ship a story

Close out one story: verify → commit → PR → Jira → dispatch reviews. The reviews
run in the background so the next story can start immediately.

**Takes a Jira key** (e.g. `SPRIN-11`). If none is given, infer it from the branch
and **confirm with the user before touching Jira.**

## 1. Verify. Evidence before assertions.

Run all four and read the actual output. Do not proceed on any failure.

```bash
npx tsc --noEmit && npx eslint . && npx prettier --check . && npx vitest run
```

**Never claim a check passed without having run it in this session.** If an AC is
not covered by a test, say so out loud rather than quietly shipping it.

## 2. Commit

Imperative summary. Body explains *why*, not what.

**Never use a heredoc for a commit message** — the External Guard hook word-splits
it and blocks on innocent words like "credentials". Use `git commit -m "$(printf '...')"`.

## 3. Push and open the PR

The PR body's job is to let a reviewer trust the work without redoing it. Structure:

- **Each AC, and *how it was checked*.** "Verified by querying the live database"
  beats "done". Name the tool or query.
- **Anything done beyond the ACs**, and why it was folded in rather than deferred.
- **A `## Not verified here` section.** State plainly what was NOT exercised and
  which story covers it. This section is required; if it is genuinely empty, say
  "everything in this PR is exercised by a test" — do not delete the heading.

## 4. Move the Jira issue to In Review

Transition IDs are workflow-specific. **Fetch them, never hardcode:**
`JIRA_GET_TRANSITIONS` → find the id whose `to.name` is `In Review` → `JIRA_TRANSITION_ISSUE`.
Add a comment linking the PR and summarising what was verified.

**Done means merged**, not "code written". Never move to Done from here.

## 5. Dispatch the reviews (background)

Two agents, `general-purpose`, **`isolation: "worktree"`**, launched in one message
so they run concurrently.

**Pin them to the pushed commit SHA.** This is the whole trick:

> Base: `origin/main`. Head: `<SHA>`. Diff: `git diff origin/main...<SHA>`.
> Read files with `git show <SHA>:<path>`. **Do not trust the working tree —
> another agent is editing it concurrently.**

Without this, the reviewers read a working tree that is already mutating with the
*next* story's code, and every finding is contaminated.

- **Peer reviewer:** correctness, CLAUDE.md scope/rule violations, tests that
  can't fail (false greens), anything the PR description overclaims. Tell it to be
  adversarial and to say "nothing substantive" rather than invent nits.
- **Security reviewer:** RLS holes (USING vs WITH CHECK asymmetry, cross-user
  reach), secret leakage, weakened defences. Require it to separate EXPLOITABLE
  from DEFENCE-IN-DEPTH and to not inflate severity.

Findings come back **to you**. Triage them, show the user what survives, and **ask
before posting anything to the PR** — a confidently-wrong agent comment lands
publicly under the user's name.

## 6. Start the next story

Branch the next story off *this* branch, not `main`, while the PR is open —
otherwise review-driven changes to it force a rebase.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Reviewers read the working tree | Findings blend two stories. Worthless. Pin the SHA. |
| Querying to verify before the user's SQL has landed | You report "nothing applied" and start a false fire drill. Re-check before alleging. |
| Hardcoding a Jira transition ID | IDs are per-workflow. Fetch them. |
| Moving Jira to Done on PR open | Done means merged and the DoD met. |
| Claiming "tests pass" from memory | Run them. Paste the count. |
