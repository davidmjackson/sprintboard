import { useState } from 'react'
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

    const result = await setStatusWipLimit(status.id, parsed.data)
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
