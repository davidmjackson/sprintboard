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

   **Measured, not reasoned.** The issue's suggested fixture was built exactly as written
   — `{'assets/x.js': 'x'.repeat(600_000) + credential}`, asserting non-zero exit — and run
   against the real script both unmutated and with recursion deleted:

   ```
   unmutated:          exit=1  BUILD REJECTED — only 1 readable file(s) … below the floor of 2
   recursion removed:  exit=1  BUILD REJECTED — only 0 readable file(s) … below the floor of 2
   ```

   It exits non-zero **either way**, and in the *unmutated* case the credential is never
   even found — a nested-only `dist/` has one readable file, below the floor, so the floor
   rejects the build before the scan matters. "Asserting non-zero exit" is therefore
   vacuous for AC1 *and* for the recursion mutation: it passes whether or not the scan
   works at all. Two routes to the same pass, and the wrong one is taken every time.

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

## What the deep review changed (second commit)

Five mutation-testing lenses in isolated worktrees planted 94 mutations and returned 14
findings. Six claimed survivals were reproduced independently before acting on any of
them; all six held. The first cut of this fix pinned **one** direction of a bug class each
time, and the review found the other direction in every case:

| Claimed by | Reproduced | Fix |
|---|---|---|
| Canary at END of file → any tail-anchored read survives (`.slice(-1024)`, `.slice(-65536)`, head+tail) | yes, 30/30 green | canary mid-file at byte 497,931 |
| Fixture 600,056 B < real bundle ~704,000 B → a size cap in that band survives | yes, 30/30 green | pad to ~808 KB, above the real artefact |
| Nesting supplied by the harness, observed by nothing → a flattening `runAgainstDist` re-opens the recursion hole with the suite green | yes, 30/30 green | assert the flagged path matches `/assets[/\\]/` |
| Only `map` pinned; `css`, `mjs`, `cjs` each still deletable | yes, 30/30 green | `it.each` over all four |
| `scannable.slice(0, 2)` survives — `assets/` sorts first so the credential was always read FIRST | yes, 30/30 green | plant in every file, count reported violations (order-independent) |
| Read error swallowed by `try/catch` → "3 files scanned, no credentials found" over an unreadable credential | yes, 30/30 green | unreadable-file fixture with a root positive control |

Also fixed, and it is the one that matters most for honesty: **the comment justifying
`cleanTopLevel` stated a mechanism that is false.** Two lenses measured it. `cleanTopLevel`
prevents a false **alarm** — without it these fixtures are RED on correct code, because the
floor rejects before the scan. The assertion that prevents a false **pass** is
`toMatch(/sb_secret_/)`, since the floor message contains no such substring;
`not.toMatch(/below the floor/)` never fires on its own. The headline claim — that each
fixture is rejected because the credential was found, never via the floor — was verified
and stands. Only my explanation of *which assertion does the work* was wrong, and it was
wrong in the commit message and the PR body too, which is the fourth
prose-rationale-no-test-honours hit on this project.

Two `Minor` findings were **not** acted on: that the small nested fixture is dominated by
its siblings (it is now the only depth-1 case, so it earns its place), and a suggestion to
delete the inert `not.toMatch(/below the floor/)` assertion (kept as belt-and-braces, with
the comment corrected to credit the right guard).

Matrix after this commit: 15 of 15 mutation classes killed, including the test-side
flattening mutation.

## That claim was false, and a third pass proved it (third commit)

**The line above — "15 of 15 killed" — was wrong when written.** A focused pass on the
second commit planted 40 more mutations and found that fixing the tail direction had
*given back* a head band:

| | `289d534` (cut 1) | `86b3a7c` (cut 2) | `ee0bfa2` (cut 3) |
|---|---|---|---|
| `.slice(0, 1024)` | red | red | red |
| `.slice(0, 524288)` — **512 KiB** | **red** | **GREEN** | red |
| `.slice(0, 600000)` | **red** | **GREEN** | red |
| `.slice(-1024)` | GREEN | red | red |

Moving the canary to byte 497,931 narrowed head coverage from "any cap below 600,000" to
"any cap below 497,932", surrendering the band that contains 512 KiB — the likeliest value
anyone would pick. **This is the story's own bug class, reintroduced by the commit meant to
close it, and then recorded as closed.** Fifth prose-rationale-no-test-honours hit, and the
first one inside the artefact meant to be the record.

No single offset fixes it. The fixture now carries **two distinct credential patterns at
opposite ends of one file**, both required to be reported —
`findPrivilegedCredentials` yields one violation per *pattern*, not per occurrence, so two
copies of one canary collapse into a single finding and prove nothing. Any contiguous
window read, head, tail or interior, now misses an end.

Also closed in cut 3: a **16th class** (a swallowed `readdir` error in `walk()` drops an
entire subtree and reported a clean bundle over a chmod-000 `assets/`); the `/assets[/\\]/`
assertion being satisfied by one separator, so a helper collapsing only the second level
stayed green; an errno-text assertion that killed nothing and went red on a strict
improvement; and an `afterWrite` call outside the try/finally that leaked a mode-000 temp
directory on every failed run.

**Accepted, not fixed** — both are bounds a fixture can only move, never remove, through a
subprocess that reports no byte count: a size cap *above* the largest fixture is invisible,
and a walk capped at depth 3+ is invisible. Stated in the PR's "Not verified here" rather
than papered over.

Final matrix: **16 of 16 killed at `ee0bfa2`**, re-derived from a committed tree.

## Not doing

- No change to `MIN_SCANNED_FILES`, `SCANNABLE`, `TEXT_PATTERNS`, or the walk.
- No byte-count floor. A "minimum bytes read" gate is the same class of tripwire as the
  file floor and would need its own headroom argument; the fixtures pin the behaviour
  directly, which is stronger and cheaper.
