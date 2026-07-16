/** "ui, urgent ," -> ["ui", "urgent"]. Trims each label, drops blanks. */
export function parseLabels(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
}
