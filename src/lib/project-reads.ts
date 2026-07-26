import { useEffect, useState } from 'react'

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
 * Note, so nobody deletes it expecting a red test: that phase check is deliberately
 * **defence in depth and no test can observe its removal**. `useTaggedRead`'s derivation
 * independently gates `items` on the phase, so a corrupted `failed`-with-items state stays
 * invisible through the public surface. Verified by mutation, not assumed. It stays because
 * it keeps the stored state honest to its own type; it is not dead weight, but it is also
 * not what protects the user — the derivation is.
 *
 * The project check, by contrast, IS observable and load-bearing: it is what stops the
 * previous project's rows rendering under the new project's header.
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
 * `read` must be a stable reference (a module-level function, not an inline arrow), or the
 * effect re-runs every render and refetches forever.
 */
export function useTaggedRead<T>(
  activeProjectId: string | undefined,
  nonce: number,
  read: (projectId: string) => Promise<T[]>,
): TaggedRead<T> {
  const [result, setResult] = useState<Tagged<T> | null>(null)

  useEffect(() => {
    if (!activeProjectId) return
    let active = true
    read(activeProjectId)
      .then((items) => {
        if (active) setResult({ projectId: activeProjectId, nonce, phase: 'loaded', items })
      })
      .catch(() => {
        if (active) setResult({ projectId: activeProjectId, nonce, phase: 'failed' })
      })
    return () => {
      active = false
    }
  }, [activeProjectId, nonce, read])

  const current = isCurrent(result, activeProjectId, nonce) ? result : null
  return {
    phase: current?.phase ?? 'loading',
    items: current?.phase === 'loaded' ? current.items : [],
    patch: (projectId, fn) => setResult((prev) => patchLoaded(prev, projectId, fn)),
  }
}
