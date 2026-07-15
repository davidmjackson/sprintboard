/**
 * Project keys, client-side.
 *
 * `PROJECT_KEY_PATTERN` is the exact mirror of the database's `projects_key_format`
 * check (`^[A-Z][A-Z0-9]{1,3}$`): first character a letter, total length 2–4,
 * uppercase alphanumeric. The database is the real boundary — this exists so the UI
 * can reject a bad key *before* the round-trip and derive a sensible suggestion. If
 * the DB constraint ever changes, change it here too (and the test pins them together).
 */
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,3}$/

export function isValidProjectKey(key: string): boolean {
  return PROJECT_KEY_PATTERN.test(key)
}

/**
 * Suggest a key from a project name — editable before save, never authoritative.
 *
 * Multi-word names become initials (`My Cool Project` → `MCP`); a single word takes
 * its first few characters (`Sprintboard` → `SPR`). Non-alphanumerics split words and
 * are dropped; a leading digit is stripped because the key must start with a letter.
 * The result may still be too short (e.g. a one-letter name) — the caller validates
 * and the user can always edit, so this only has to be a *good guess*, not correct.
 */
export function deriveProjectKey(name: string): string {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
  if (words.length === 0) return ''

  const source = words.length === 1 ? words[0]! : words.map((w) => w[0]!).join('')

  // Drop leading digits BEFORE taking the prefix — the key must start with a letter,
  // and stripping first keeps the letters a digit-led name still has (0123abc -> ABC,
  // not ''). Single word takes its first characters; multi-word takes its initials.
  const letters = source.replace(/^[0-9]+/, '')
  return letters.slice(0, words.length === 1 ? 3 : 4)
}
