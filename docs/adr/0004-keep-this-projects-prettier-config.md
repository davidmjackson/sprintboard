# ADR 0004 — Keep this project's Prettier config

**Status:** Accepted, 2026-07-25
**Overrides:** the standard's `profiles/typescript/.prettierrc.json`

## Context

The standard ships `semi: true`; this repo has been `semi: false` since the
first commit. The two configs otherwise agree (`printWidth` 100, `singleQuote`,
`trailingComma: "all"`), and this repo additionally needs
`prettier-plugin-tailwindcss` for class ordering.

Adopting the standard's file would add a semicolon to the end of nearly every
statement in the repo. `format:check` is inside `npm run verify`, so this is not
optional cleanup: it is a mandatory whole-repo rewrite, in one commit, that
moves `git blame` for almost every line — with no effect on any measured
threshold.

## Decision

Keep `.prettierrc.json` as it is. Formatting style is not a threshold; T1–T5,
duplication and coverage are, and none of them are affected by semicolons.

`npm run format:check` remains in `verify` and remains the formatting gate.

## Consequences

- Code copied between this repo and a standard-conformant one needs one
  `prettier --write` pass. Accepted.
- If the standard's Prettier config is ever adopted, do it as its own commit,
  touching nothing else, so the diff stays reviewable as pure formatting.
