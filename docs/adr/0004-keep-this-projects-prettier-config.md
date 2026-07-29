# ADR 0004 — Keep this project's Prettier config

**Status:** Accepted, 2026-07-25. Still in force — see the amendment below.
**Originally:** an override of the standard's `profiles/typescript/.prettierrc.json`

> **Amended 2026-07-29 (SPRIN-55).** This project is no longer wired to
> `/var/www/CodingStandards` at all: the T1–T5 thresholds, the duplication gate and
> ADRs 0001/0002/0003/0005 were removed with the rest of the pivot's third slice.
> So this is no longer an *override* of anything — `.prettierrc.json` is simply this
> project's formatting config, and the decision below stands on its own reasoning.
> The references to the standard and to T1–T5 in the Context and Decision sections
> are left as written, because they record why the choice was made at the time.
> **Do not read them as evidence the standard is still adopted here.** It is not,
> deliberately; `CLAUDE.md` is authoritative on that.

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
