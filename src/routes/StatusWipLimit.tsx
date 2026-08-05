import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import type { ProjectStatus } from '@/lib/domain'
import { setStatusWipLimit } from '@/lib/project-statuses'
import { WipLimitSchema } from '@/lib/status-schemas'
import { Input } from '@/components/ui/input'
import { GENERIC_CREATE_ERROR } from './CreateDialog'

/** The status's limit as the input shows it: `null` — no limit — is an empty field, never
 *  a `0`, which is the one value the rule forbids. */
function toDraft(limit: number | null): string {
  return limit === null ? '' : String(limit)
}

/**
 * One status's WIP limit, on the settings row.
 *
 * **Its own file and its own component**, rather than more of `StatusRow.tsx`, because this
 * is a self-contained write path — parse, guard, write, tag, report — of the same weight as
 * `StatusDeleteControl`. `StatusRow.tsx` already assembles three components; a fourth would
 * make it the place status editing lives rather than the place a status ROW is assembled.
 *
 * **Deliberately NOT built on `EditableText`,** for three reasons any one of which decides
 * it: that component commits a raw string with nowhere to parse-and-refuse before writing;
 * its numeric mode hardcodes `min={0}`, which contradicts the rule this adds; and its view
 * mode is a button, whereas a settings field should show its value and be directly
 * editable. There is also a recorded hazard in reusing it — its own `draft !== value` guard
 * is unpinned and unpinnable from `StatusSettings.test.tsx`, because the row's trim guard
 * shadows it. The no-op guard below is written explicitly and tested directly instead.
 *
 * A BLUR IS NOT AN INTENT TO WRITE. Tabbing through the settings tab would otherwise fire a
 * PATCH per status. The parsed value is compared with the row's own before anything is
 * sent — the same discipline as `StatusRow`'s rename.
 *
 * TAKES A GENERATION GUARD, UNLIKE `AddStatusForm`. `AddStatusForm`'s docblock explains why
 * it deliberately skips the one `CreateDialog` gives every dialog (SPRIN-51): that form is
 * always mounted, with no open/close transition to race. This field has no such shelter — a
 * settings row is long-lived and its commits are user-paced (Enter, then blur, then another
 * edit), so two writes CAN genuinely be in flight at once, and PostgREST gives no ordering
 * guarantee on which response lands first. Without the guard, an older response arriving
 * after a newer one overwrites the newer value in the parent's state with a stale one.
 *
 * RESYNCS `draft` FROM THE PROP, BUT ONLY WHILE THE FIELD IS IDLE. `StatusSettings.tsx`
 * renders each row keyed on `status.id`, so this component instance survives any OTHER
 * write on the settings tab — a rename, a reorder, a refetch — and would otherwise keep
 * showing a limit the database no longer holds. Gating on focus is what keeps that resync
 * from fighting a user mid-edit: a keystroke does not touch `status`, only a prop change
 * does, so "is this element focused right now" is the one check that tells the two apart.
 */
export function StatusWipLimitField({
  status,
  onUpdated,
}: {
  status: ProjectStatus
  onUpdated: (status: ProjectStatus) => void
}) {
  const [draft, setDraft] = useState(() => toDraft(status.wip_limit))
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const commitGeneration = useRef(0)

  useEffect(() => {
    if (document.activeElement === inputRef.current) return
    setDraft(toDraft(status.wip_limit))
  }, [status.wip_limit])

  async function commit() {
    const parsed = WipLimitSchema.safeParse(draft)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? GENERIC_CREATE_ERROR)
      return
    }
    // Cleared BEFORE the no-op check, not after it: every commit is a fresh attempt, and the
    // previous attempt's message describes none of them. `StatusRow`'s rename fixed exactly
    // this bug from the other side.
    setError(null)
    if (parsed.data === status.wip_limit) return

    const generation = ++commitGeneration.current
    const result = await setStatusWipLimit(status.id, parsed.data)
    // A newer commit started while this one was in flight — its result, whenever it lands,
    // is the one that gets to speak. Applying this one now would be the out-of-order bug.
    if (generation !== commitGeneration.current) return

    if (!result.ok) {
      setError(GENERIC_CREATE_ERROR)
      return
    }
    onUpdated(result.value)
  }

  function revert() {
    setDraft(toDraft(status.wip_limit))
    setError(null)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      revert()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      void commit()
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5">
      <Input
        ref={inputRef}
        type="number"
        inputMode="numeric"
        min={1}
        className="h-8 w-20 text-sm"
        placeholder="None"
        aria-label={`WIP limit for ${status.name}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={handleKeyDown}
      />
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  )
}
