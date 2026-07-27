import { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

/** Small uppercase eyebrow label, shared by every sidebar field. */
export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground/80 text-[11px] font-semibold tracking-wide uppercase">
      {children}
    </span>
  )
}

/** Click-to-edit text/number field. View mode is a button; edit mode is an input or
 *  textarea. Enter (single-line) or blur commits a changed value; Esc cancels.
 *  The view-mode button reveals a pencil cue on hover/focus — the one motif repeated
 *  across every editable field in the dialog, so the whole modal reads as "click
 *  anything to edit it" without a single instructional sentence. */
export function EditableText({
  value,
  ariaLabel,
  multiline,
  numeric,
  placeholder,
  heading,
  onCommit,
  onEditingChange,
}: {
  value: string
  ariaLabel: string
  multiline?: boolean
  numeric?: boolean
  placeholder?: string
  heading?: boolean
  onCommit: (next: string) => void
  /** Reports edit-mode transitions up to the dialog, so it can tell Radix's Escape
   *  handler "a field is mid-edit — cancel the field, don't close the dialog." */
  onEditingChange?: (editing: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  // The view-mode "Edit …" button, so focus can be handed back to it when a field
  // exits edit mode — otherwise the input unmounts and Radix's FocusScope drops focus
  // to the dialog root, throwing keyboard/SR users to the top of the tab order.
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Set by commit()/cancel() to request a refocus once the view-mode button is back in
  // the DOM; a ref (not state) so setting it never itself triggers a render.
  const refocusTriggerRef = useRef(false)
  useEffect(() => {
    if (!editing && refocusTriggerRef.current) {
      refocusTriggerRef.current = false
      triggerRef.current?.focus()
    }
  }, [editing])

  function start() {
    setDraft(value)
    setEditing(true)
    onEditingChange?.(true)
  }
  function commit(refocus: boolean) {
    setEditing(false)
    onEditingChange?.(false)
    // Refocus-to-trigger is a KEYBOARD affordance (Enter commits). A blur means focus is
    // already moving on intentionally (Tab, or a click onto another field's edit button),
    // so yanking it back would steal it — force the user to Tab twice / re-click.
    if (refocus) refocusTriggerRef.current = true
    if (draft !== value) onCommit(draft)
  }
  function cancel() {
    setEditing(false)
    onEditingChange?.(false)
    refocusTriggerRef.current = true
    setDraft(value)
  }

  if (!editing) {
    return (
      <button
        type="button"
        ref={triggerRef}
        aria-label={`Edit ${ariaLabel}`}
        onClick={start}
        className={cn(
          'group hover:bg-muted/60 focus-visible:bg-muted/60 -mx-2 flex w-[calc(100%+1rem)] items-start justify-between gap-2 rounded-md px-2 py-1 text-left outline-none',
          heading ? 'text-xl font-semibold' : 'text-sm',
        )}
      >
        <span className={cn(!value && 'text-muted-foreground font-normal')}>
          {value || placeholder || 'Empty'}
        </span>
        <Pencil
          aria-hidden="true"
          className="text-muted-foreground mt-1 size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </button>
    )
  }

  const commonProps = {
    autoFocus: true,
    'aria-label': ariaLabel,
    value: draft,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => commit(false),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
      if (e.key === 'Enter' && !multiline) {
        e.preventDefault()
        commit(true)
      }
    },
  }

  return multiline ? (
    <Textarea rows={3} className="text-sm" {...commonProps} />
  ) : (
    <Input
      type={numeric ? 'number' : 'text'}
      min={numeric ? 0 : undefined}
      placeholder={placeholder}
      className={cn(heading && 'h-auto py-1 text-xl font-semibold md:text-xl')}
      {...commonProps}
    />
  )
}
