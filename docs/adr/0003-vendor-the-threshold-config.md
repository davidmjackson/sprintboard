# ADR 0003 — Restate the thresholds in `eslint.standards.config.js`

**Status:** Accepted, 2026-07-25 — revisit when the shared config is published
**Tension with:** the standard's "do not restate these numbers elsewhere"

## Context

The standard's intended consumption path is one dependency reference:

```bash
npm install -D @codequalitystandards/eslint-config
```

That package is **not published to any registry**. Locally it can only be
consumed as a packed tarball — a `file:` dependency on the directory breaks,
because npm symlinks it and Node then resolves the config's own imports from the
symlink's real path, where there is no `node_modules`. Committing a `.tgz` into
this repo to make CI reproducible would put an opaque binary in a repo whose
`check-bundle.mjs` discipline exists to keep the artefact auditable.

A path reference to the checkout (`/var/www/CodingStandards`) is not an option
either: that path does not exist on the CI runner.

## Decision

Restate the six rule values in `eslint.standards.config.js`, with a header
naming `core/THRESHOLDS.md` as the source of truth and the ADRs as the
overrides. `eslint-plugin-sonarjs` is a normal devDependency (its peer range
covers ESLint 10, which this repo is on; the standard's own profile still pins
`@eslint/js` ^9).

When `@codequalitystandards/eslint-config` is published, replace the rule block
with a re-export and delete this ADR.

## Consequences

- **The numbers can drift from the standard silently.** Nothing checks them —
  accepted for a non-gating report, and the reason this ADR is written to be
  deleted rather than kept.
- The config stays reproducible on a clean CI runner with no extra checkout.
