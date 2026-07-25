import { FieldLabel, selectClass } from './EditableText'

/** One choosable row in a reference picker: the id that gets written to the ticket, and
 *  how that row reads in the list. */
export type ReferenceOption = { id: string; label: string }

/**
 * A labelled `<select>` that points one ticket field at another row — the parent epic, the
 * sprint. Both pickers are the same three-part list (a "none" entry, an optional "the
 * current value is not in the list" entry, then the options) and both must keep the
 * `<select>` controlled on a value the list has lost, so the rule lives here once instead
 * of being mirrored by hand in two places. The caller supplies the words, the option list
 * and the patch; the fallback entry appears on its own whenever `value` is missing from
 * `options`.
 */
export function TicketReferenceSelect({
  label,
  ariaLabel,
  value,
  noneLabel,
  unavailableLabel,
  options,
  disabled,
  onChange,
}: {
  label: string
  ariaLabel: string
  value: string | null
  noneLabel: string
  unavailableLabel: string
  options: ReferenceOption[]
  disabled?: boolean
  onChange: (next: string | null) => void
}) {
  return (
    <label className="flex flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      <select
        aria-label={ariaLabel}
        className={selectClass}
        disabled={disabled}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{noneLabel}</option>
        {value && !options.some((o) => o.id === value) ? (
          <option value={value}>{unavailableLabel}</option>
        ) : null}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
