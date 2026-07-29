# SPRIN-56 — check-bundle cannot tell a full-content scan from a truncated one

**Type:** Bug (under E8, SPRIN-8). **Branch:** `sprin-56-check-bundle-truncation`.
**Boundary:** secret handling — the control that stops a Supabase service-role key
reaching the browser bundle. Warrants the deep multi-agent review pass.

## The defect, reproduced before anything was written

`scripts/check-bundle.mjs` behaves **correctly** today: it reads whole files
(`readFileSync(file, 'utf8')`, no slice), walks `dist/` recursively, and `SCANNABLE`
includes `map`. Nothing in the suite **pins** any of that. Three mutations were applied
to the real script on this branch and the suite re-run each time:

| # | Mutation | Result |
|---|---|---|
| 1 | `readFileSync(file, 'utf8').slice(0, 1024)` | **27 passed** — survived |
| 2 | `walk()` recursion removed (`isDirectory() ? [] : [path]`) | **27 passed** — survived |
| 3 | `map` dropped from `SCANNABLE` | **27 passed** — survived |

3/3 survived; script reverted, tree clean. So this is a **test-coverage defect, not a
behaviour defect** — the fix is fixtures that would have gone red, plus the one helper
change they need. No change to the control's logic.

(The issue says "34-test suite"; the suite is 27 tests at `99d0c07`. The count moved
after that review. The gap, not the count, is what mattered.)

## Why the existing fixtures cannot see it

Every `dist/` fixture is a single sub-200-byte line written **flat** into `dist/`, with
the credential at roughly byte 12. A real Vite build is the opposite shape: `index.html`
at top level, and the chunk carrying inlined `VITE_*` values under `dist/assets/`, with a
planted key landing around byte 497,931 of ~704,000. `MIN_SCANNED_FILES` does not help —
it counts files *opened*, never bytes *read*.

## Decisions

1. **Test-side only.** The script's logic is already right; adding a byte-count assertion
   inside the script would be a second control to keep honest, when the fixtures are what
   is missing. Scope stays at the ACs.

2. **Fixture size 600,000 bytes**, per the issue's own suggested fix, matching the real
   bundle's order of magnitude. It defeats both proven truncation shapes — a fixed
   `.slice(0, 1024)` prefix *and* "skip files over 10,000 bytes" — because the file is
   both long and carries its credential past any plausible prefix. ~600KB of tmp I/O per
   test, which is milliseconds.

3. **Three fixtures, not two.** The issue suggests one fixture closing truncation and
   nesting together. That fixture is kept, because it mirrors a real build — but a second,
   *small* nested fixture is added so a recursion regression names itself instead of being
   diagnosed through a 600KB haystack. Third fixture plants a key in a `.map`.

4. **Every new fixture clears the floor with clean top-level files, and asserts the
   rejection names `sb_secret_` and is NOT the floor message.** This is the decision the
   issue did not make, and without it the fixtures are worthless:

   A nested-only `dist/` (`assets/x.js` and nothing else) contains **one** readable file.
   That is below `MIN_SCANNED_FILES`, so the script exits non-zero with
   `only 1 readable file(s) … below the floor of 2` — the test passes **without the
   credential ever being found**, and stays green under the recursion mutation it exists
   to kill. Two routes to the same pass; the second road has to be closed explicitly.

   So each new fixture: ≥ `MIN_SCANNED_FILES` clean readable files at top level, credential
   nested underneath, and three assertions — non-zero status, stderr matches `sb_secret_`,
   stderr does **not** match `below the floor`.

5. **`runAgainstDist` gains `mkdirSync(dirname(path), { recursive: true })`.** It currently
   writes flat, so a nested fixture name throws `ENOENT`. Every existing flat fixture is
   unaffected. This is the only helper change.

## Acceptance criteria → artefact

- **AC1** credential beyond a 1KB prefix in a nested subdirectory is detected, non-zero
  exit → the 600KB `dist/assets/` fixture.
- **AC2** truncating the read, removing recursion, and dropping `map` each turn the suite
  RED → verified by re-applying all three mutations after the fixtures land, and watching
  which tests fail. Each must be killed by the fixture aimed at it, not incidentally.
- **AC3** `npm run verify` green; check-bundle stays a step inside `npm run build` —
  already pinned by the existing `package.json` wiring tests, untouched here.

## Not doing

- No change to `MIN_SCANNED_FILES`, `SCANNABLE`, `TEXT_PATTERNS`, or the walk.
- No byte-count floor. A "minimum bytes read" gate is the same class of tripwire as the
  file floor and would need its own headroom argument; the fixtures pin the behaviour
  directly, which is stronger and cheaper.
