import { useEffect, useRef, useState } from 'react'

/**
 * The three-state shape both of the project shell's reads share (S4.6).
 *
 * `failed` is a real variant, not an empty list. Flattening a rejection into `[]` is
 * exactly the defect S4.6 removed: the read looked finished AND successful, so a paused
 * database rendered as "Nothing in the backlog." rather than an error. Any consumer must
 * consult the phase before treating an empty list as "none".
 */
export type ReadPhase = 'loading' | 'loaded' | 'failed'

/**
 * A result tagged with the project AND the nonce it belongs to.
 *
 * Tagging is what makes `loading` a *derived* fact — "no result has landed for this
 * project at this nonce yet" — rather than a flag an effect has to reset synchronously
 * (which `react-hooks/set-state-in-effect` rejects as a cascading-render hazard). It also
 * means switching projects can never flash the previous project's rows under the new
 * header, and bumping the nonce invalidates a stale result *instantly* rather than when
 * the replacement lands. A Retry that leaves the error on screen reads as a no-op, and
 * gets hammered.
 */
type Tagged<T> =
  | { projectId: string; nonce: number; phase: 'loaded'; items: T[] }
  | { projectId: string; nonce: number; phase: 'failed' }

/** Is this result the one we are currently waiting on, rather than a stale arrival? */
function isCurrent<T>(
  result: Tagged<T> | null,
  projectId: string | undefined,
  nonce: number,
): boolean {
  return result !== null && result.projectId === projectId && result.nonce === nonce
}

/**
 * Apply `fn` to a loaded list, leaving `loading` and `failed` untouched.
 *
 * The `phase === 'loaded'` test keeps a patch from reading `.items` off a variant that has
 * none and building a `loaded` state out of a `failed` one — the "a failed read looks
 * successful" defect S4.6 removed. Spreading `prev` preserves the tag rather than
 * rebuilding it.
 *
 * Note, so nobody deletes it expecting a red test: this phase check and the phase gate in
 * `useTaggedRead`'s derivation are a **symmetric redundant pair**. Removing either one alone
 * is invisible to the whole suite; removing BOTH is caught (by "patch is a no-op on a failed
 * read"). Measured by mutation, in both directions — do not read this as "the derivation is
 * the real guard and this one is decoration", because the identical argument licenses
 * deleting the derivation gate instead, and neither deletion goes red on its own.
 *
 * What actually keeps users safe is upstream of both: the effect never constructs a `failed`
 * variant carrying `items`, so the corrupt state has no way to exist. These two are the
 * belt and braces that keep it that way if someone changes the effect.
 *
 * The project check, by contrast, IS individually observable and load-bearing: it is what
 * stops the previous project's rows rendering under the new project's header.
 */
function patchLoaded<T>(
  prev: Tagged<T> | null,
  projectId: string,
  fn: (items: T[]) => T[],
): Tagged<T> | null {
  return prev && prev.projectId === projectId && prev.phase === 'loaded'
    ? { ...prev, items: fn(prev.items) }
    : prev
}

/**
 * A ref that always holds the latest `value`, so a callback can be used inside an effect
 * without becoming one of its dependencies. See `useTaggedRead` for why that matters here.
 */
function useLatest<T>(value: T) {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  })
  return ref
}

type RunReadArgs<T> = {
  read: (projectId: string) => Promise<T[]>
  projectId: string
  nonce: number
  /** False once this effect run has been superseded by a switch, retry or unmount. */
  isActive: () => boolean
  setResult: (result: Tagged<T>) => void
}

/**
 * Issue one read and record its outcome, unless this run has been superseded.
 *
 * Hoisted out of the hook body rather than written inline so `useTaggedRead` stays inside
 * the 30-line threshold — the rule S9.1 established for hooks that live in `.ts`.
 *
 * The `isActive` check on the REJECTION path matters as much as on the success path, and is
 * the easier one to drop while tidying. Without it, a rejection arriving after the user has
 * switched projects overwrites state with a stale-tagged `failed`; `isCurrent` then discards
 * that as stale, so the NEW project sits on `loading` forever. No further effect fires, and
 * the tabs only render Retry on `failed` — so nothing short of a page reload recovers it.
 */
function runRead<T>({ read, projectId, nonce, isActive, setResult }: RunReadArgs<T>): void {
  read(projectId)
    .then((items) => {
      if (isActive()) setResult({ projectId, nonce, phase: 'loaded', items })
    })
    .catch(() => {
      if (isActive()) setResult({ projectId, nonce, phase: 'failed' })
    })
}

/**
 * Which of several tagged reads should gate rendering, and why.
 *
 * The rule is two passes, not one: *any* `failed` beats *any* `loading`, then source order
 * within each kind. A board with three reads (tickets, sprints, statuses) must keep showing
 * an already-known failure even while another read is still in flight — collapsing this to a
 * single ordered scan (`reads.find((r) => r.phase !== 'loaded')`) would let a `loading` read
 * that merely appears earlier in the list mask a real failure later in it, replacing an error
 * with a spinner that never resolves, because nothing ever retries a `loading` phase on its
 * own. `BoardTab` already has this precedence today, hand-written as three `if`s over two
 * reads; this is that rule, extracted once so a third read costs one array entry rather than
 * another `if`.
 *
 * `R` is generic rather than fixed to `string` so it infers the caller's own resource union
 * (e.g. `'tickets' | 'sprints' | 'statuses'`) at the call site. `resource` flows straight into
 * `LoadFailure`, whose prop is a deliberately closed union — a security control documented on
 * that component, since an open `string` channel would let raw PostgREST error text render into
 * a `role="alert"`. Typing this helper to `string` would compile clean and dissolve that
 * control silently, without anyone touching `LoadFailure` itself.
 *
 * **`extends string` is what makes that inference actually happen — do not drop it.** It is not
 * a tidy-up of an unconstrained parameter. Inferring to a *naked* `R` widens each object
 * literal's `resource` to `string`, so `<R>` alone produced exactly the outcome the paragraph
 * above warns against. Measured when `BoardTab` became the first consumer (SPRIN-76 task 5):
 * with `<R>` the board failed to compile with `Type 'string' is not assignable to type
 * 'LoadFailureResource'`, and with `<R extends string>` it infers the union and compiles. The
 * failure is loud rather than silent, which is why nothing shipped broken — but the mechanism
 * this docblock described did not work until the constraint was added.
 */
export function firstUnready<R extends string>(
  reads: readonly { resource: R; phase: ReadPhase }[],
): { resource: R; phase: 'failed' | 'loading' } | null {
  const failed = reads.find((r) => r.phase === 'failed')
  if (failed) return { resource: failed.resource, phase: 'failed' }
  const loading = reads.find((r) => r.phase === 'loading')
  return loading ? { resource: loading.resource, phase: 'loading' } : null
}

/** What `useTaggedRead` hands back: the derived view, plus a guarded local mutator. */
export type TaggedRead<T> = {
  phase: ReadPhase
  /** `[]` while loading and when the read failed — always check `phase` first. */
  items: T[]
  /** Patch the list in place. A local mutation, never a refetch: an unguarded refetch
   *  resolving after a project switch would clobber the new project's list. */
  patch: (projectId: string, fn: (items: T[]) => T[]) => void
}

/**
 * One project-scoped, retryable, three-state read.
 *
 * The shell has two of these (tickets and sprints) and they were near-identical twins —
 * same tagging, same `active` cleanup, same derivation — differing only in the fetch
 * function. Keeping one implementation means the S4.6 invariant above is enforced in a
 * single place instead of being re-argued at every call site.
 *
 * `read` is held in a ref rather than listed as an effect dependency, and that is not a
 * lint workaround — it removes a footgun this hook would otherwise introduce. Depending on
 * `read` directly means an inline arrow at any call site (`(id) => listTickets(id)`) is a
 * fresh reference every render, so the effect re-runs, sets state, re-renders, and refetches
 * forever. Measured, not theorised: a probe with an inline `read` and no external rerenders
 * reached ~1.2M invocations in five seconds — an unbounded burst of requests and a hung tab.
 *
 * Nothing automated would catch it. `react-hooks/exhaustive-deps` *requires* the dependency,
 * so lint stays silent, and the parameter's type cannot express "stable reference". The
 * pre-refactor code had no such hazard because the fetch was written inline in the effect;
 * the ref keeps the dependency list identical to that original.
 *
 * **The scope is not always a project.** SPRIN-88 reads a ticket's custom field values, which
 * are scoped to a TICKET, so the first parameter is `scopeId` rather than `activeProjectId` —
 * a positional-only rename with no behaviour change. Nothing in the hook ever meant "project"
 * specifically; it means "the id this read belongs to, and switching it invalidates the
 * result". The internals still say `projectId` where they describe the tag, because switching
 * projects is the case the staleness rules were written against and remains the sharpest one.
 */
export function useTaggedRead<T>(
  scopeId: string | undefined,
  nonce: number,
  read: (scopeId: string) => Promise<T[]>,
): TaggedRead<T> {
  const [result, setResult] = useState<Tagged<T> | null>(null)

  const readRef = useLatest(read)

  useEffect(() => {
    if (!scopeId) return
    let active = true
    runRead({
      read: readRef.current,
      projectId: scopeId,
      nonce,
      isActive: () => active,
      setResult,
    })
    return () => {
      active = false
    }
    // `readRef` is listed only to satisfy `exhaustive-deps`, which cannot see through
    // `useLatest` to know it returns a ref. `useRef` hands back the same object for the
    // life of the component, so this is referentially stable and the effect still re-runs
    // on exactly `scopeId` and `nonce` — the pre-refactor dependency list.
  }, [scopeId, nonce, readRef])

  const current = isCurrent(result, scopeId, nonce) ? result : null
  return {
    phase: current?.phase ?? 'loading',
    items: current?.phase === 'loaded' ? current.items : [],
    patch: (projectId, fn) => setResult((prev) => patchLoaded(prev, projectId, fn)),
  }
}
