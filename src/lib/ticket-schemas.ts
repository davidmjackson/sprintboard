import { z } from 'zod'

import { TICKET_TYPES, type TicketType } from './domain'

/**
 * The create-ticket form rules (SPRIN-89) — the client edge of CLAUDE.md's
 * validate-at-both-edges, same as `field-schemas.ts` and `status-schemas.ts`.
 *
 * **A separate module rather than living in `CreateTicketDialog.tsx`, and for the same reason
 * `status-schemas.ts` exists apart from its own dialog.** `CreateTicketValues` has two
 * consumers in two files: `CreateTicketDialog.tsx` builds the form from it, and
 * `CreateTicketCustomFields.tsx` needs it too, to type its `control` prop. Declaring the type
 * in the dialog and importing it into the custom-fields component would be an import cycle the
 * moment the dialog also imports the custom-fields component to render it — which it does.
 * Hoisting the schema (and the type it produces) up to a leaf module both files can import from
 * closes the cycle before it opens, exactly as `status-schemas.ts`'s docblock describes for its
 * own two consumers.
 *
 * **A non-obvious fact this split exists to protect against re-learning by trial and error:
 * react-hook-form's `Control<T>` is effectively INVARIANT in `T`, not covariant.** A first
 * attempt at this story declared a local structural-minimum type in the custom-fields
 * component — `{ custom?: Record<string, string> }` — reasoning that since it names a subset
 * of `CreateTicketValues`'s fields, `Control<CreateTicketValues>` ought to satisfy
 * `Control<{ custom?: ... }>` at the call site with no cast. It does not, and the reason is
 * structural: `Control<T>`'s internal `FormStateSubjectRef` carries `T` inside its subscriber
 * callbacks' PARAMETER position (a `values?: T` on the object an `Observer` is called with),
 * which is a contravariant position. TypeScript checks function parameters contravariantly, so
 * a `Control` typed for a wider value shape is not assignable to a `Control` typed for a
 * narrower one — the reverse of what a plain object's own field-superset rule would predict.
 * Confirmed with a minimal, unrelated two-field reproduction before this file existed, so it is
 * not an artifact of this schema's own shape: any attempt to give a form-consuming component a
 * locally-declared "just the fields I need" type for its `Control` prop will hit the same wall.
 * The only type-safe fix is for every consumer of a `Control` to share the exact same
 * `TFieldValues` type — which is what importing `CreateTicketValues` from here, rather than
 * re-declaring a narrower shape per component, actually buys.
 */
export const CreateTicketSchema = z.object({
  summary: z
    .string()
    .trim()
    .min(1, 'Summary is required')
    .max(200, 'Keep the summary to 200 characters or fewer'),
  type: z.enum([...TICKET_TYPES] as [TicketType, ...TicketType[]]),
  description: z.string().trim().max(2000).optional(),
  // Kept a string on the form (so the input stays controlled); parsed to a number at
  // submit. Empty means "no estimate". Digits only, ≤ 3, so it stays a sane int.
  storyPoints: z
    .string()
    .trim()
    .regex(/^\d{0,3}$/, 'Whole numbers only')
    .optional(),
  labels: z.string().optional(),
  acceptanceCriteria: z.string().trim().max(2000).optional(),
  // `.optional()` on the RECORD, not required, and that is measured rather than stylistic:
  // `.parse()` THROWS when `custom` is absent, so a required field would make the whole submit
  // path depend on `defaultValues.custom = {}` still existing — and deleting that line would
  // surface as a rejected promise and a dialog that silently does nothing, not as a failing
  // test.
  //
  // The VALUE schema is `z.string().optional()`, not a bare `z.string()`. React-hook-form's
  // `Controller` only writes a path once its `onChange` fires — a custom field the user never
  // touched stays `undefined` at `custom.<fieldId>` rather than becoming `''`, because
  // `CreateTicketCustomFields` computes `rhf.value ?? ''` for DISPLAY only and never calls
  // `onChange('')` to seed it. A bare `z.string()` value schema then throws "Invalid input:
  // expected string, received undefined" the moment a project has two-plus custom fields and
  // only one is filled — reproduced live, not hypothesised. `parseFieldValues` was designed for
  // exactly this: it takes `Record<string, string | undefined>` and its own test ("treats a
  // missing record entry as empty rather than throwing") already covers an absent key, and
  // `raw[field.id] ?? ''` covers a present-but-undefined one identically. So `.optional()` here
  // is enough on its own — no `z.preprocess` needed, and the output type
  // (`Record<string, string | undefined> | undefined`) lines up with `parseFieldValues`'s
  // parameter type exactly.
  custom: z.record(z.string(), z.string().optional()).optional(),
})

export type CreateTicketValues = z.input<typeof CreateTicketSchema>
