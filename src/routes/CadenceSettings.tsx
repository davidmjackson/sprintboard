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
      {/* NO EXPLANATORY LINE, DELIBERATELY. The obvious sentence here — "new sprints are
          suggested from this" — describes behaviour THIS STORY DOES NOT SHIP. The pre-fill
          is SPRIN-96; until it lands the cadence is inert and this section only reports it.
          Copy that promises an unbuilt feature is a false claim a user can read, which is
          worse than a false comment. SPRIN-96 adds the sentence when it becomes true. */}
    </section>
  )
}
