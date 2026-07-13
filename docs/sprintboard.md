# Handover Brief: Sprintboard Session 1 (Foundation + Jira board)

## Objective
Stand up the Jira tracking board for all of Phase 1, then deliver Epic E1
(Foundation and Infrastructure) end to end. Leave a running, secured, testable
skeleton and a fully populated board.

## Read first, in order
1. `CLAUDE.md` at repo root. Scope, conventions, security, DoD. The locked
   scope is hard. Do not exceed it.
2. `sprintboard_phase1_schema.sql`. The schema you will apply.
3. `sprintboard_phase1_backlog.md`. The epics and stories to create and deliver.

---

## Step 1: Create the Jira board
- Target Jira project: confirm with me if it is not already set. Do not guess.
- Create all 8 epics from the backlog, then create the 31 stories, each linked
  to its parent epic.
- Verify the board columns map to To Do, In Progress, In Review, Done. Adjust
  the Jira workflow if needed. Do not change the app's fixed columns.
- Leave every issue in To Do.

## Step 2: Deliver Epic E1, story by story
Work S1.1 through S1.6 in order. For each story:
1. Move the Jira issue to In Progress.
2. Write the acceptance tests from the story's ACs first.
3. Implement on a feature branch.
4. Open a PR and move the issue to In Review.
5. On green CI and merge, move the issue to Done.

Story-specific notes:
- **S1.2:** before creating the signup trigger, check whether Supabase already
  wired `on_auth_user_created`. Do not duplicate it.
- **S1.3:** the two-user RLS isolation test must be automated and added to CI.
- **S1.4:** document the heartbeat schedule and endpoint in CLAUDE.md.

---

## Guardrails
- Build no Rung 2 or Rung 3 feature. If a story seems to need one, stop and flag it.
- Never put the service-role key in the browser.
- Do not work around the atomic key counter, the blocked-sync trigger, or the
  one-active-sprint index.
- Do not disable or bypass the guard hooks.

## Definition of done for this session
- All 8 epics and 31 stories exist in Jira, correctly linked, all in To Do
  except the E1 issues you complete.
- E1 stories are merged and their Jira issues are Done.
- App runs locally, CI is green, the RLS two-user test passes.
- CLAUDE.md updated with the heartbeat details.

## Stop and ask me if
- The target Jira project or its workflow is ambiguous.
- The schema fails to apply cleanly or a trigger conflicts.
- Any story appears to need a parked feature to satisfy its ACs.

## Next session
Session 2 picks up Epic E2 (Authentication), same per-story protocol.
