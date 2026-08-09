import { cadenceSummary, type SprintCadence } from '@/lib/domain'

/**
 * The project's sprint cadence, read-only — a section of the Settings tab beside
 * `StatusSettings` and `CustomFieldSettings`.
 *
 * Presentational by design: it takes a `SprintCadence` rather than a `Project`, so it reads
 * the narrowest shape it needs (the same discipline as `hasSprints`) and holds no opinion
 * about project type. `SettingsTab` decides whether this section exists at all — which keeps
 * the project-type comparison in one place, where
 * `src/test/project-type-single-expression.test.ts` can see it.
 *
 * The editing form is SPRIN-97. Deliberately no button here: a control with no write path
 * behind it is worse than its absence.
 */
export function CadenceSettings({ cadence }: { cadence: SprintCadence }) {
  return (
    <section aria-labelledby="cadence-settings-heading" className="flex flex-col gap-2">
      <h2 id="cadence-settings-heading" className="text-lg font-semibold">
        Sprint cadence
      </h2>
      <p className="text-sm">{cadenceSummary(cadence)}</p>
      <p className="text-muted-foreground text-sm">
        New sprints are suggested from this. You can always change a sprint&rsquo;s dates.
      </p>
    </section>
  )
}
