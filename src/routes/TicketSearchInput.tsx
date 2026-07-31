import { Input } from '@/components/ui/input'

/**
 * The ticket search box, shared by the Board and the Backlog so the label, the accessible
 * name and the styling cannot drift between the two surfaces.
 *
 * Controlled: the query lives in each tab as local view state, never in
 * `ProjectShellContext`. Hoisting it would make the Backlog's query follow you to the Board —
 * a behaviour no AC asks for. Same call S7.3 made for the blocked-only checkbox, and filters
 * are not persisted to the URL or storage in Phase 1.
 *
 * A native `<input type="search">` wrapped in a `<label>`, not a radix control: the label
 * gives it an accessible name, `getByRole('searchbox', { name: /search/i })` then works in
 * jsdom, and there is no popover behaviour to want.
 *
 * The caller decides WHETHER to render this, and must decide it from the UNFILTERED list —
 * gating it on the filtered result strands the user, because a query that matches nothing
 * would remove the only control that could clear it.
 */
export function TicketSearchInput({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  return (
    <label className="flex w-full max-w-xs flex-col gap-1">
      <span className="text-muted-foreground text-sm">Search tickets</span>
      <Input
        type="search"
        value={value}
        placeholder="Key or summary"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}
