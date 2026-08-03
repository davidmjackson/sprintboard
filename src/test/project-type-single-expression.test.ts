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
 * IT IS A TEXT SCAN, AND IT FAILS OPEN — WHICH IS WHY THERE ARE THREE OF THEM. Said
 * plainly rather than dressed up, because the guard next door
 * (`project-type-immutability.test.ts`) has a long docblock on why it parses the AST
 * instead, and the difference is deliberate rather than an oversight. That guard polices
 * WRITE PATHS, where an unreadable answer has to count as a failure — a `project_type`
 * write it cannot see is a write it cannot forbid. This one polices a spelling.
 *
 * AN EARLIER DRAFT OF THIS PARAGRAPH ARGUED THAT A PARSER WOULD BUY NOTHING, on the
 * grounds that "every construction that defeats it also defeats an AST scan of string
 * literals, because none of them is a string literal". **That was simply false, and a
 * reviewer proved it by planting a mutation that survived both scans below:**
 *
 *     const kind: string = project.project_type
 *     const showsSprintFilters = kind === 'scrum'
 *
 * left beside a correct `hasSprints(project)` call, so the behaviour tests agreed with it.
 * `kind === 'scrum'` contains a real string literal; so do `switch (p.project_type) { case
 * 'scrum': }` and the Yoda form `'scrum' === p.project_type`. All three are trivially
 * reachable by an AST walk, all three were invisible here, and `npm run lint` was clean
 * throughout. The honest claim is narrower: an OBFUSCATED spelling
 * (`String.fromCharCode(107, …)`, `PROJECT_TYPES[1]`, a computed key, the value arriving
 * from the database at runtime) defeats a literal scan of either kind. An ALIASED
 * comparison does not — it merely defeats a scan that looks at the comparison instead of
 * at the read.
 *
 * SO THE THIRD SCAN POLICES THE READ, NOT THE COMPARISON, and that is what closes the
 * shape above. Once a component has `project.project_type` in a local, the comparison can
 * be spelled a hundred ways and no scan of comparisons will keep up; there is exactly one
 * way to GET the value, and it is a `.project_type` property access. Outside `domain.ts`,
 * the only permitted appearance of that read is as an index into `PROJECT_TYPE_LABELS` —
 * the header badge, which needs the display name and cannot get it from a predicate.
 * Everything else must go through `hasSprints`. It stays a text scan for the same reason
 * as the other two (a regex over `.project_type` has nothing a parser would resolve for
 * it), but it is now aimed at the chokepoint rather than at the many shapes downstream of
 * it.
 *
 * WHAT STILL SURVIVES ALL THREE, stated so nobody has to rediscover it by mutation — and
 * stated PRECISELY, because the first draft of this paragraph overstated it and an
 * overstated hole is its own hazard: it invites the next reader to pay for an allowlist
 * against something already covered.
 *
 * A PLAIN DESTRUCTURE IS NOT A HOLE. `const { project_type } = project` binds a variable
 * whose NAME is `project_type`, so the comparison that must eventually follow it reads
 * `project_type === 'scrum'` and scan 2 fires. Measured, not reasoned: planting exactly
 * that in a component reddens this file.
 *
 * The one shape that survives all three is a destructure THAT RENAMES:
 *
 *     const { project_type: kind } = project
 *     return kind === 'scrum'
 *
 * — no leading dot for scan 3, no adjacent operator for scan 2, no `kanban` for scan 1.
 * Also measured. It is narrow and conspicuous: a reviewer reading a rename whose only
 * purpose is to launder the column name has been handed the finding rather than hidden
 * from it.
 *
 * Closing even that would mean banning the bare word `project_type`, which needs an
 * allowlist for `projects.ts`'s insert payload, `CreateProjectDialog.tsx`'s prose and the
 * whole of the generated `database.types.ts` — and an allowlist is where a guard starts
 * accumulating the exceptions that eventually make it meaningless (the same argument the
 * value scan makes below for pinning `kanban` rather than `scrum`). Naming one narrow
 * hole is worth more than a guard nobody trusts.
 *
 * What a raw text match buys over a literal-only scan, in the other direction: it also
 * catches `kanban` as an object KEY — `{ scrum: …, kanban: … }` — which is the shape an
 * inlined second copy of `PROJECT_TYPE_LABELS` would take, and which is a property name
 * rather than a literal.
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
 * AND THAT LEFT THE LIKELIEST VIOLATION OF ALL UNCOVERED, which is why there is a third
 * scan below — see the aliased-comparison passage above for the mutation that proved it.
 * The comparison scan matches only where `project_type` sits ADJACENT to an operator, so
 * one intervening local defeats it completely. The third scan forbids the READ.
 *
 * The three scans are deliberately NOT redundant, and it is worth being precise about why,
 * because several guards over one rule usually means one of them is masking the others.
 * They fail on disjoint mutations. An inlined `PROJECT_TYPE_LABELS` copy, or a
 * `{ kanban: … }` lookup map, is caught by the value scan, contains no comparison at all
 * and reads no `.project_type`. An inlined `project_type === 'scrum'` is caught by the
 * comparison scan and contains no `kanban`. An aliased `const kind = project.project_type`
 * is caught by the read scan alone — no `kanban`, and no operator next to the field.
 * Delete any one of them and a real regression stops being visible.
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

/**
 * The ONE permitted `.project_type` read outside `domain.ts`: an index into the label map.
 *
 * `ProjectShellHeader` renders the type badge, and a display name is the one thing a
 * boolean predicate cannot supply — `hasSprints` answers "does it have sprints", not "what
 * is this called". So the header reads the field and hands it straight to
 * `PROJECT_TYPE_LABELS`, which is `domain.ts`'s own map: the label still lives in exactly
 * one place, and the header holds the value for the width of one subscript and does
 * nothing else with it. That is a lookup, not a second derivation of the rule.
 *
 * Deliberately TIGHT — `[\w.]*` admits `project.project_type` and `p.project_type` and
 * nothing else. `PROJECT_TYPE_LABELS[someHelper(p.project_type)]` is NOT permitted and
 * will be reported: the moment the value passes through a call on its way to the
 * subscript, this scan can no longer see that the call is a lookup rather than a rule.
 */
const PERMITTED_LABEL_INDEX = /PROJECT_TYPE_LABELS\[\s*[\w.]*\.project_type\s*\]/g

/**
 * Reading the project's type off a row, in the column's own spelling. Unlike
 * RAW_COMPARISON this says nothing about what is DONE with the value, which is the entire
 * point: there is one way to obtain it and unboundedly many ways to test it.
 *
 * `\b` on the end so `.project_type_label` or `.project_typed` would not match — there is
 * no such field today, and a guard that fires on a name it does not mean is a guard people
 * learn to edit rather than to obey.
 */
const RAW_READ = /\.project_type\b/

const FILES = sourceFiles(SRC_ROOT)

/** Every non-test source file that names the value, as `src/`-relative paths. */
const NAMING_FILES = FILES.filter((file) =>
  readFileSync(file, 'utf8').includes(PROJECT_TYPE_VALUE),
).map((file) => relative(SRC_ROOT, file))

/** Every non-test source file that compares the field directly, as `src/`-relative paths. */
const COMPARING_FILES = FILES.filter((file) => RAW_COMPARISON.test(readFileSync(file, 'utf8'))).map(
  (file) => relative(SRC_ROOT, file),
)

/**
 * Every non-test source file holding a `PROJECT_TYPE_LABELS[….project_type]` index, and
 * how many it holds in total. This is the READ scan's positive control, and it has to
 * count rather than merely find: the assertion below works by STRIPPING these matches
 * before looking for what is left, so a stripper that matched nothing and a stripper that
 * matched everything both produce a spotless tree. One of those is a broken guard.
 */
const LABEL_INDEX_FILES = FILES.filter((file) =>
  // `.test()` on a `/g` regex is stateful (`lastIndex` survives between calls), which
  // makes it silently skip every other file. `.match()` has no such trap, and the count
  // is what the control asserts anyway.
  readFileSync(file, 'utf8').match(PERMITTED_LABEL_INDEX),
).map((file) => relative(SRC_ROOT, file))

const LABEL_INDEX_COUNT = FILES.reduce(
  (total, file) => total + (readFileSync(file, 'utf8').match(PERMITTED_LABEL_INDEX)?.length ?? 0),
  0,
)

/**
 * Every non-test source file that reads `.project_type` OTHER than as a label lookup, as
 * `src/`-relative paths — the permitted form is removed from the text first, so what
 * remains is by construction a read this rule does not allow.
 *
 * `domain.ts` is excluded by file rather than by shape: `hasSprints` is the rule, so the
 * one read that IS the single expression of it cannot also be a violation of it.
 */
const READING_FILES = FILES.filter((file) => {
  if (relative(SRC_ROOT, file) === VOCABULARY_HOME) return false
  return RAW_READ.test(readFileSync(file, 'utf8').replace(PERMITTED_LABEL_INDEX, ''))
}).map((file) => relative(SRC_ROOT, file))

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

  /**
   * The third angle, and the one a reviewer had to plant a mutation to justify. Both scans
   * above look for a SPELLING — the value, or the field sitting next to an operator — and
   * one intervening local defeats both:
   *
   *     const kind: string = project.project_type   // no 'kanban', no adjacent operator
   *     const showsSprintFilters = kind === 'scrum'
   *
   * That shipped green past everything, `npm run lint` included, sitting beside a correct
   * `hasSprints(project)` call so no behaviour test disagreed with it either. This scan
   * closes it by policing the READ rather than the comparison: whatever a file intends to
   * do with the type, it must first take `.project_type` off a row, and outside
   * `domain.ts` the only permitted way to do that is to hand it straight to the label map.
   *
   * SAME ORDERING RULE AS THE TWO ABOVE, AND HERE IT MATTERS MOST, because this assertion
   * is the only one in the file that works by SUBTRACTION. It strips the permitted form
   * and reports what survives — so a stripper that removed too much, or a reader that
   * returned nothing, reports a perfectly clean tree while asserting nothing whatsoever.
   * The two controls come first and they check opposite failures: at least one file must
   * still hold a permitted index after the walk (the reader works), and the total number
   * of stripped matches must be exactly what the tree contains (the stripper is not
   * eating the file). Splitting them into their own `it` would let the absence assertion
   * pass in a run where they had already failed.
   */
  it('reads the project type only as a label lookup, outside domain.ts', () => {
    expect(
      LABEL_INDEX_FILES,
      `The read scan walked ${FILES.length} file(s) and found no ` +
        'PROJECT_TYPE_LABELS[….project_type] anywhere. That is the header badge, which is ' +
        'the one permitted read outside domain.ts — so either the badge moved (in which ' +
        'case this control needs re-pointing at wherever it went) or the walk has stopped ' +
        'reading, in which case the assertion below strips nothing from nothing and would ' +
        'approve an aliased comparison anywhere in the tree.',
    ).toContain('routes/ProjectShellHeader.tsx')

    expect(
      LABEL_INDEX_COUNT,
      'The permitted-form regex matched a different number of label lookups than this ' +
        'tree contains. If a second legitimate lookup was added, raise this number ' +
        'deliberately; if it dropped to 0 while the file check above still passed, ' +
        'PERMITTED_LABEL_INDEX has been loosened into something that matches the file ' +
        'rather than the form, and the assertion below is now stripping real violations ' +
        'out of the text before it looks for them.',
    ).toBe(1)

    expect(
      READING_FILES,
      `SPRIN-82 AC5: these files read .project_type themselves instead of asking ` +
        `hasSprints() in ${VOCABULARY_HOME}. This is the shape BOTH scans above miss — ` +
        'assign the field to a local and the value never spells "kanban" and never sits ' +
        'next to an operator, so a second derivation can sit quietly beside a correct ' +
        'hasSprints() call with the whole suite green until the two disagree. The only ' +
        'permitted read out here is PROJECT_TYPE_LABELS[project.project_type], because a ' +
        'display name is the one thing a predicate cannot return. Everything else needs a ' +
        'predicate exported from domain.ts — not a copy of one.',
    ).toEqual([])
  })
})
