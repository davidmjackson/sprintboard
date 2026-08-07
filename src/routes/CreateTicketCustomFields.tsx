import type { Control } from 'react-hook-form'

import type { CustomFieldType, ProjectField } from '@/lib/domain'
import type { ReadPhase } from '@/lib/project-reads'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { selectClass } from './form-primitives'

/**
 * The structural minimum of the create-ticket form this component needs.
 *
 * `CreateTicketValues` (in `./CreateTicketDialog`) only gains a `custom` key once task 5 wires
 * this component in, and it is not exported today — so a value OR type import of it from here
 * would fail to resolve, not merely risk a cycle. Declaring the shape locally sidesteps that
 * without waiting on the export, and gets the same "closes no cycle" property an `import type`
 * would have: this type is erased at build regardless of where it is declared. When task 5 adds
 * `custom?: Record<string, string>` to `CreateTicketValues`, `Control<CreateTicketValues>` is
 * assignable to `Control<CreateTicketFormShape>` — `Control` only needs the fields it names to
 * exist and match, and this shape names none `CreateTicketValues` won't also have — so the call
 * site in task 5 needs no cast.
 */
export type CreateTicketFormShape = { custom?: Record<string, string> }

/**
 * What a create-form control needs: today's typed value and a setter, nothing else. No
 * commit-on-blur and no per-field error plumbing — react-hook-form and `FormMessage` already
 * own validation display, and nothing is written to the database until Create is pressed.
 */
type CreateControlProps = {
  value: string
  onChange: (value: string) => void
}

/**
 * The renderer, as a MAP KEYED BY TYPE — never an if/else chain. A map entry costs no
 * cyclomatic point where an `if`/`else` chain costs one per branch, and `satisfies
 * Record<CustomFieldType, …>` turns a sixth field type into a compile error here rather than a
 * field that silently renders nothing. `TicketCustomFields.tsx`'s `CONTROLS` map gives the
 * identical reasoning for the sidebar's own version.
 *
 * **This does NOT reuse `TicketCustomFields`'s `CONTROLS`.** Those wrap `EditableText`'s
 * click-to-edit motif, which is right for a saved ticket — a stray keystroke there would
 * overwrite live data, so committing on blur/Enter matters. Nothing is saved until this whole
 * form submits, so every control here is a plain, always-editable input instead, matching every
 * built-in field `CreateTicketDialog` already renders (`summary`, `description`, …).
 *
 * **`select` renders a disabled control rather than nothing.** SPRIN-91's add-field form offers
 * all five types today, so rendering no control for `select` would be a field the user just
 * created and could not find on the create dialog. It stays disabled because
 * `project_field_options` does not exist until story 5 (SPRIN-92) ships it — until
 * `tfv_option_fk` lands, a free-text editor here would let someone type a value that constraint
 * then refuses, and a disabled control cannot produce a value, so it contributes nothing to the
 * write. That is the correct behaviour, not a gap.
 *
 * **`number` passes no `min`.** `min={0}` on `CreateTicketDialog`'s own `storyPoints` field is
 * the ESTIMATION rule, a property of story points rather than of arithmetic — SPRIN-88 made the
 * matching call for the ticket-detail sidebar. A custom `number` field might be a temperature, a
 * variance or a balance, so nothing here bounds it.
 */
const CREATE_CONTROLS = {
  text: (p: CreateControlProps) => (
    <Input value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
  paragraph: (p: CreateControlProps) => (
    <Textarea rows={3} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
  number: (p: CreateControlProps) => (
    <Input
      type="number"
      inputMode="decimal"
      value={p.value}
      onChange={(e) => p.onChange(e.target.value)}
    />
  ),
  date: (p: CreateControlProps) => (
    <Input type="date" value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
  select: (p: CreateControlProps) => (
    <select className={selectClass} value={p.value} disabled>
      <option value={p.value}>{p.value || '—'}</option>
    </select>
  ),
} as const satisfies Record<CustomFieldType, (p: CreateControlProps) => React.ReactElement>

/**
 * One custom field's label and control, bound to `custom.<field.id>` on the create form.
 *
 * `render(...)` is CALLED here, and its return — a DOM element — is `FormControl`'s direct
 * child, rather than rendering a component as `<Control ... />`. `FormControl` is a radix
 * `Slot.Root`, which clones its direct child to attach `id`, `aria-describedby` and
 * `aria-invalid`. A component wrapper receives those as ordinary props and, unless it explicitly
 * forwards them onto a DOM node, drops them — at which point `FormLabel`'s `htmlFor` points at
 * an id nothing wears, and the label silently stops being associated with the input. Calling the
 * render function inline keeps the clone target the actual `<input>`/`<textarea>`/`<select>`.
 * `getByLabelText` in the test file is what proves this association holds.
 */
function CreateTicketCustomFieldRow({
  control,
  field,
}: {
  control: Control<CreateTicketFormShape>
  field: ProjectField
}) {
  // Bound to a local, then called. `CREATE_CONTROLS[field.type](props)` is a call through a
  // computed member, which `project-type-immutability.test.ts` check 1 forbids anywhere under
  // `src/` — see `parseFieldValue`'s docblock in `src/lib/ticket-field-values.ts` for why that
  // guard is shaped this way.
  const render = CREATE_CONTROLS[field.type]

  return (
    <FormField
      control={control}
      name={`custom.${field.id}`}
      render={({ field: rhf }) => (
        <FormItem>
          <FormLabel>{field.name}</FormLabel>
          <FormControl>
            {render({
              // `?? ''` is load-bearing: `form.reset()` restores `custom` to `{}`, at which
              // point this path has no value, and a bare `value={rhf.value}` would flip the
              // input from controlled to uncontrolled mid-life.
              value: rhf.value ?? '',
              onChange: rhf.onChange,
            })}
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

/**
 * The project's custom fields, rendered as controls on the create-ticket form (SPRIN-89). Not
 * wired into `CreateTicketDialog` yet — task 5 does that — so every prop here defaults to the
 * value that describes a dialog with no field wiring at all: a standalone
 * `<CreateTicketDialog projectId="p1" />`, exactly how the seven pre-existing dialog tests
 * render it, must render nothing extra. That is AC5.
 *
 * The empty check is BEFORE the phases, matching `TicketCustomFieldsBody`'s order: once the
 * definitions are known and the project has none, this renders nothing rather than a
 * "Loading…" line for values it will never need. Controls are not rendered at all while
 * loading, for the same reason as the sidebar: an empty control says, in the only language a
 * control has, "there is no value here" — inviting the user to fill in a field that may not
 * exist.
 *
 * **A failed definitions read must not block creating a ticket.** Custom fields are optional
 * metadata on this form, which is deliberately weaker than `ProjectShellHeader`'s gate on
 * `ticketsPhase` — that gate hides the create trigger outright, because a ticket created while
 * the list can't be shown would be invisible, and an invisible create risks a duplicate.
 * Nothing here is invisible: the ticket itself is unaffected by whether its custom-field
 * controls could be shown, so a failed read degrades to a message rather than blocking the
 * form.
 */
export function CreateTicketCustomFields({
  control,
  fields = [],
  fieldsPhase = 'loaded',
}: {
  control: Control<CreateTicketFormShape>
  fields?: ProjectField[]
  fieldsPhase?: ReadPhase
}): React.ReactElement | null {
  if (fieldsPhase === 'loaded' && fields.length === 0) return null

  if (fieldsPhase === 'failed') {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Custom fields couldn’t be loaded. You can set them on the ticket after it’s created.
      </p>
    )
  }

  if (fieldsPhase === 'loading') {
    return <p className="text-muted-foreground text-sm">Loading…</p>
  }

  return (
    <>
      {fields.map((field) => (
        <CreateTicketCustomFieldRow key={field.id} control={control} field={field} />
      ))}
    </>
  )
}
