# Plan — SPRIN-56 check-bundle scan coverage

Design: `docs/superpowers/specs/2026-07-29-sprin-56-check-bundle-scan-coverage-design.md`.
One file changes: `scripts/check-bundle.test.mjs`. The script itself is **not** edited.

## Global constraints

- `npx tsc --noEmit` checks **zero files** here and exits 0 — it is not a verification.
  Use `npm run verify` (lint → format:check → build → full `npm test`).
- Thresholds T1–T5 are **errors** in `npm run lint`: 30-line functions, cyclomatic 10,
  cognitive 15, 4 parameters, 400-line files. `check-bundle.test.mjs` is 375 lines and the
  400-line file cap applies to it — the additions must not push it over. If they do, that
  is a real signal to extract, not to disable.
- Prettier is enforced by `format:check`. Run `npm run format` before verifying.
- Never weaken an existing assertion to make room.

## Task 1 — let the fixture helper write nested paths

In `runAgainstDist`, before each `writeFileSync`, create the parent directory:

```js
const path = join(distDir, name)
mkdirSync(dirname(path), { recursive: true })
writeFileSync(path, contents)
```

Add `dirname` to the existing `node:path` import. `recursive: true` makes this a no-op for
the flat names every existing fixture uses.

## Task 2 — the three fixtures

All three go in the existing `main() as a real subprocess` describe block, after the
"still rejects a planted key … surrounded by unreadable assets" test.

Shared shape — clean top-level filler clears `MIN_SCANNED_FILES` so the floor is not what
rejects the build:

```js
const CANARY = 'const k = "sb_secret_abcdefghijklmnopqrstuvwxyz0123456789"'

function expectRejectedForTheKey(result) {
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/sb_secret_/)
  expect(result.stderr).not.toMatch(/below the floor/)
}
```

1. **Deep + nested** (AC1): `dist/index.html` + `dist/assets/index.js` where the JS is
   `'x'.repeat(600_000) + '\n' + CANARY`. Plus one more clean top-level `.js` so the
   readable top-level count alone is ≥ 2.
2. **Nested, small**: same shape, `dist/assets/nested.js` = `CANARY` only. Isolates the
   recursion regression.
3. **`.map`**: `dist/assets/index.js.map` = `CANARY`, top-level filler clean.

Each asserts via `expectRejectedForTheKey`. Keep the helper small — the 30-line function
cap applies.

## Task 3 — prove the fixtures kill the mutations

Re-apply each mutation to `scripts/check-bundle.mjs`, run the suite, record **which named
tests fail**, then `git checkout` the script. Required outcome:

| Mutation | Must redden |
|---|---|
| `.slice(0, 1024)` on the read | fixture 1 only |
| `walk()` recursion removed | fixtures 1, 2, 3 |
| `map` dropped from `SCANNABLE` | fixture 3 only |

A mutation that reddens *nothing*, or a fixture reddened only by the floor message, means
the fixture is not doing its job — fix the fixture, do not accept the pass.

## Task 4 — verify and ship

`npm run format` → `npm run verify` in full, run by me, not a subagent. Confirm the test
**file** count gap vs `test:unit` is still 7 and 0 tests skipped. Then `ship-story`.
