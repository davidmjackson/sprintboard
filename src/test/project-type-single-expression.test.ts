import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SRC_ROOT, sourceFiles } from './source-ast'

/**
 * SPRIN-82 AC5 — "`hasSprints` is the only expression of the rule".
 *
 * The rule is `project_type === 'scrum'`, and it has three consumers in this story alone
 * (the nav link, the sprints route, the ticket detail's sprint picker) with more arriving
 * in SPRIN-83, -85 and -86. Two call sites reading the raw string can drift; one predicate
 * cannot. That is the same discipline `doneSlugs()` carries for "terminal" (SPRIN-77),
 * where the drift was not hypothetical: the database filter and the optimistic reducer had
 * to move onto one derivation together, because either one alone dragged finished tickets
 * back into the backlog.
 *
 * HOW MUCH OF AC5 THIS ACTUALLY PINS, which is less than the whole of it. The POSITIVE
 * half — that each component consults the predicate at all — is pinned by behaviour: the
 * absence tests in `ProjectShell.test.tsx`, `SprintsTab.test.tsx` and
 * `TicketSprintField.test.tsx` go red the moment a component stops asking. This file owns
 * only the NEGATIVE half, and only one specific regression: a second, inlined comparison
 * sitting quietly beside a correct call, where every behaviour test stays green because
 * the two agree — until the day they do not.
 *
 * IT IS A TEXT SCAN, AND IT FAILS OPEN. Said plainly rather than dressed up, because the
 * guard next door (`project-type-immutability.test.ts`) has a long docblock on why it
 * parses the AST instead, and the difference is deliberate rather than an oversight. That
 * guard polices WRITE PATHS, where an unreadable answer has to count as a failure — a
 * `project_type` write it cannot see is a write it cannot forbid. This one polices a
 * spelling, and there is no such thing as an unreadable spelling: every construction that
 * defeats it (`String.fromCharCode(107, …)`, `PROJECT_TYPES[1]`, a computed key, the value
 * arriving from the database at runtime) also defeats an AST scan of string literals,
 * because none of them is a string literal. Reaching for the parser here would buy nothing
 * and read as protection it does not provide.
 *
 * What it does buy over a literal-only scan is breadth in the other direction: a raw text
 * match also catches `kanban` as an object KEY — `{ scrum: …, kanban: … }` — which is the
 * shape an inlined second copy of `PROJECT_TYPE_LABELS` would take, and which is a
 * property name rather than a literal.
 *
 * MATCHED CASE-SENSITIVELY, which is a rule about prose as much as code. `kanban` is the
 * VALUE; `Kanban` is the display name, and it lives in `PROJECT_TYPE_LABELS` in
 * `domain.ts` alongside it. Comments may name the concept freely as long as they
 * capitalise it — `ProjectShellHeader.tsx:44` already does, and its comment is the reason
 * this distinction is worth having rather than a coincidence. A lower-case `kanban` in a
 * comment reddens this test, and the fix is to capitalise it, not to loosen the match.
 *
 * WHY THE VALUE SCAN LOOKS FOR `kanban` AND NOT `scrum`. Not symmetry-blindness: `'scrum'`
 * legitimately appears outside `domain.ts` today, as the create-project form's
 * `defaultValues` (`CreateProjectDialog.tsx:51`) and in a docblock in `projects.ts`
 * describing the column default. Banning it would need an allowlist, and an allowlist is
 * where a guard starts accumulating the exceptions that eventually make it meaningless.
 * `kanban` has no legitimate site outside `domain.ts` and is the value every branch this
 * epic adds is testing FOR, so it is the spelling worth pinning.
 *
 * THAT LEFT THE LIKELIEST VIOLATION UNCOVERED, which is why there is a second scan below.
 * `hasSprints` returns `project_type === 'scrum'` — so the most probable way AC5 breaks is
 * not someone typing `'kanban'`, it is someone copying the predicate's OWN BODY inline,
 * spelled `'scrum'`, which the value scan cannot see. The second scan takes the other
 * angle: it forbids the raw COMPARISON rather than the value. `project_type ===` outside
 * `domain.ts` is wrong whichever value follows it, so it needs no allowlist and stays
 * blind to the two legitimate `'scrum'` sites above — neither is a comparison.
 *
 * The two scans are deliberately NOT redundant, and it is worth being precise about why,
 * because two guards over one rule usually means one of them is masking the other. These
 * fail on disjoint mutations. An inlined `PROJECT_TYPE_LABELS` copy, or a `{ kanban: … }`
 * lookup map, is caught by the value scan and contains no comparison at all. An inlined
 * `project_type === 'scrum'` is caught by the comparison scan and contains no `kanban`.
 * Delete either and a real regression stops being visible.
 *
 * WHAT IT DOES NOT CLOSE. CLAUDE.md's broader rule — "status, type and column definitions
 * live in `src/lib/domain.ts` and nowhere else" — is still unpinned in general. Inlining a
 * label map for ticket types, sprint statuses or status categories passes everything in
 * this repo today. Closing that properly means a repo-wide lint rule and an ADR to justify
 * it; this file is one story's worth of that job, not the job.
 *
 * Test files are excluded by `sourceFiles()`, deliberately and permanently: fixtures build
 * Kanban projects by naming the value, and `domain.test.ts` asserts the union spells it.
 * Scanning them would be a red that can never be fixed.
 */

/**
 * The one file allowed to name the value, relative to `src/`. Not a list, and adding a
 * second entry rather than a call to `hasSprints` is the failure this whole file exists to
 * make visible — if a second entry looks unavoidable, that is the signal `domain.ts` needs
 * another predicate exported from it, not that the guard needs widening.
 */
const VOCABULARY_HOME = 'lib/domain.ts'

/** The value, spelled as code spells it. See the case-sensitivity note above. */
const PROJECT_TYPE_VALUE = 'kanban'

/**
 * A raw equality or inequality test against the project-type field, in either the column's
 * spelling (`project_type`, on a `Project` row) or the form's (`projectType`, on the
 * create-dialog's zod input). Both are the same rule wearing different clothes.
 *
 * Anchored on a lower-case `p` so it cannot match the TYPE name `ProjectType` — `isProjectType`
 * and the `AssertProjectType*` guards are declarations, not comparisons, and are none of this
 * scan's business.
 */
const RAW_COMPARISON = /project_?[Tt]ype\s*[=!]==?/

const FILES = sourceFiles(SRC_ROOT)

/** Every non-test source file that names the value, as `src/`-relative paths. */
const NAMING_FILES = FILES.filter((file) =>
  readFileSync(file, 'utf8').includes(PROJECT_TYPE_VALUE),
).map((file) => relative(SRC_ROOT, file))

/** Every non-test source file that compares the field directly, as `src/`-relative paths. */
const COMPARING_FILES = FILES.filter((file) => RAW_COMPARISON.test(readFileSync(file, 'utf8'))).map(
  (file) => relative(SRC_ROOT, file),
)

describe('only domain.ts names the kanban project type (SPRIN-82 AC5)', () => {
  /**
   * One test, three assertions, and the order matters. A scan that found no files, or one
   * whose reader silently returned nothing, reports a perfectly clean tree — so the two
   * positive controls come FIRST, and each has its own message saying which half broke.
   * Splitting them into separate `it`s would let the absence assertion pass in a run where
   * the controls had already failed, which is exactly the vacuous green this epic named as
   * its likeliest failure mode.
   */
  it('names it in domain.ts and nowhere else in non-test source', () => {
    expect(
      FILES.length,
      `Only ${FILES.length} non-test source file(s) found under ${SRC_ROOT}. This guard ` +
        'reports a clean tree by finding nothing, so a scan this small is a broken scan, ' +
        'not a clean result. Fix the walk rather than lowering the floor.',
    ).toBeGreaterThanOrEqual(40)

    expect(
      NAMING_FILES,
      `The scan read ${FILES.length} file(s) and did not find '${PROJECT_TYPE_VALUE}' in ` +
        `${VOCABULARY_HOME}, where PROJECT_TYPES and ProjectType both spell it. Either the ` +
        'vocabulary moved out of domain.ts — in which case fix this constant — or the ' +
        'reader has stopped reading, in which case the assertion below is vacuous and ' +
        'would approve an inlined comparison anywhere in the tree.',
    ).toContain(VOCABULARY_HOME)

    expect(
      NAMING_FILES,
      `SPRIN-82 AC5: hasSprints() in ${VOCABULARY_HOME} is the only expression of "does ` +
        'this project have sprints", and these files name the project type themselves. A ' +
        'second inlined comparison agrees with the predicate until someone changes one of ' +
        'them, and every behaviour test stays green in the meantime. Call hasSprints() ' +
        '(or export a new predicate from domain.ts) instead. If this is prose in a ' +
        'comment, capitalise it: the concept is Kanban, the value is kanban.',
    ).toEqual([VOCABULARY_HOME])
  })

  /**
   * The other angle, and the one that catches the likelier mistake. See the docblock above
   * for why this is not redundant with the value scan: the two fail on disjoint mutations,
   * and an inlined `project_type === 'scrum'` — a copy of `hasSprints`'s own body — trips
   * only this one.
   *
   * Same ordering rule as above: the control first. A regex that matches nothing anywhere
   * reports a spotless tree.
   */
  it('compares the project type in domain.ts and nowhere else in non-test source', () => {
    expect(
      COMPARING_FILES,
      `The comparison scan read ${FILES.length} file(s) and found no raw project-type ` +
        `comparison in ${VOCABULARY_HOME}, where hasSprints() performs exactly one. Either ` +
        'the predicate was rewritten to compare some other way — in which case update ' +
        'RAW_COMPARISON — or the regex has stopped matching, in which case the assertion ' +
        'below is vacuous and would approve an inlined comparison anywhere in the tree.',
    ).toContain(VOCABULARY_HOME)

    expect(
      COMPARING_FILES,
      `SPRIN-82 AC5: these files test the project type directly instead of calling ` +
        `hasSprints() from ${VOCABULARY_HOME}. This is the shape the value scan above ` +
        "cannot see, because hasSprints() is written `=== 'scrum'` and an inlined copy " +
        'of it never mentions kanban at all. Two derivations of one rule agree until ' +
        'someone changes one of them.',
    ).toEqual([VOCABULARY_HOME])
  })
})
