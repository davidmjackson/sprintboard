# Sprintboard

A working Jira alternative for a single team: Scrum and Kanban boards, a backlog,
tickets that move by status, and drag and drop. Part of the Sprint Suite.

Built solo. React 19 and TypeScript on Vite, talking straight to Supabase with no
backend of its own.

---

## What it does

- **Projects** are Scrum or Kanban, chosen at creation and immutable after.
- **Tickets** are epic, story, bug or task. Create, edit, delete, estimate,
  assign, label, block.
- **Statuses** are per project. Rename them, reorder them, add your own, set a WIP
  limit. Every status carries a category (todo, in progress, done) and the board
  columns are the status rows.
- **The board** shows the active sprint on a Scrum project, or every ticket on a
  Kanban one. Cards drag between columns and the drop writes the status.
- **The backlog** holds everything not in a sprint. Completing a sprint returns
  its unfinished tickets there and keeps the finished ones.
- **Members** are admins or members. Admins configure the project, members do
  board work.

Scope is frozen. See the top of `CLAUDE.md` for what is deliberately absent.

---

## Running it

Node 20 (`.nvmrc`). You need a Supabase project.

```bash
npm install
cp .env.example .env.local     # fill in URL and anon key
npm run dev
```

Apply `docs/sprintboard_phase1_schema.sql` to a fresh Supabase project, then the
files in `docs/migrations/` in filename order. Migrations are hand-applied through
the SQL editor on purpose: the Supabase MCP is wired read-only.

```bash
npm run verify    # lint, format, build, test. This is the merge gate.
npm run test:unit # fast loop, skips the live database suites
npm run e2e       # Playwright happy path
```

The live integration suites need the extra credentials in `.env.example` and will
skip without them.

---

## The one architectural decision worth knowing

**There is no backend. The database is the entire authorisation layer.**

The browser holds a Supabase anon key and queries Postgres directly. Nothing sits
between a user and the tables except row-level security, so every access rule is a
policy rather than a middleware check. Ten tables, thirty-one policies, and an
`app_auth` schema of `SECURITY DEFINER` predicates that PostgREST does not expose.

Three consequences that shape the whole codebase:

1. **RLS is tested live, against a real database, on every pull request.** A unit
   test with a mocked client cannot see a policy. `src/test/*.integration.test.ts`
   runs two real users against real tables and asserts what each can and cannot
   reach. This is why the test suite is large.
2. **Reads throw rather than return `[]` on failure.** An empty array is
   indistinguishable from an empty board, so a failed read that resolved to `[]`
   would render "No tickets yet" over a database it never reached. That bug
   shipped once and the pattern exists to stop it recurring.
3. **A leaked service-role key would be total.** It bypasses RLS, and Vite inlines
   any `VITE_`-prefixed variable into the bundle. `scripts/check-bundle.mjs` greps
   the built output and fails the build if a privileged credential reaches `dist/`.

---

## Layout

```
src/lib/        domain rules, schemas and every Supabase call. No JSX.
src/routes/     screens and components.
src/test/       live integration suites. Real database, real users.
docs/adr/       decisions and their reasoning.
docs/migrations/ hand-applied SQL, in filename order.
```

Domain rules live in `src/lib` and never in a component. Status names, ticket
types and project types are declared in `src/lib/domain.ts` and nowhere else.

---

## Honest notes

- Drag and drop reorders between columns but **rank within a column is not
  persisted**. Cards sort by ticket number.
- There is no change history, no subtasks, no comments and no attachments.
- Source comments are dense in places and record superseded reasoning. A cleanup
  pass is tracked; treat `CLAUDE.md` and `docs/adr/` as authoritative where a
  docblock disagrees with them.
