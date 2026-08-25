# Removing Kùzu — the four subsystems that still hold it in place

**Operator decision, 2026-08-06: the goal is removing Kùzu entirely, not
running two engines.** Migrating graph data does not achieve that — Kùzu keeps
running for the subsystems below, so a migrated workspace has *two* engines
instead of one. This work is the fast path to the actual objective.

Branch from `main` (`a993d82`). Do not push to `main`.

**Acceptance test for the whole effort:** a workspace can be opened, written,
read, backed up and restored **with no Kùzu database on disk and no kuzu-lite
import on the code path.** Everything below serves that. If a step doesn't move
that test closer, it isn't in scope.

---

## Item 0 — correct the scope before building anything

I have described this as "four subsystems to port." I checked, and that framing
is at least partly wrong. What I verified:

**Collections / table storage is already off Kùzu by default.**
`engines/localGraph.ts:1483-1503` reads `LORE_TABLE_BACKEND`, which **defaults to
`'sqlite'`**. `SqliteTableStorage` (`engines/sqliteTableStorage.ts`, backed by
better-sqlite3, file `<workspace>/.lore/tables.sqlite`) is the live path.
`KuzuTableStorage` is reached only when someone explicitly sets the variable to
`'kuzu'` to read legacy data. That file's own header says hosting all three
substrates on Kùzu "was a convenience… meant Kùzu carried double duty," and the
split has already happened.

The same code block says: *"Switching backends does NOT migrate data — tables
written with one backend are invisible to the other. A one-time migration helper
is on the backlog."* That helper is the remaining work, not a new backend.

**Analytical projections may be moot.** `mcp/analyticalGetter.ts:10` describes
itself as riding "the boot-bound LocalGraph's `KuzuCollectionStorage`
connection" — i.e. it depends on the *Kùzu collection* path, which is the legacy
one. If that path goes away with the item above, this may resolve with it rather
than needing its own port. **Determine this before scoping it.**

**Two look genuinely unported:**
- `security/kuzuPendingOpsStore.ts` — a real Kùzu node table `lore_pending_op`
  (the human-in-the-loop approvals queue).
- `security/rebac.ts` — a real Kùzu rel table `LoreRebacEdge`.

**Start by confirming or refuting all four of the above**, and report what you
find before building. If my reading is wrong, the plan changes and I would
rather change it now. This project's consistent failure mode — mine more than
yours — is a plausible mechanism inferred from a real symptom, so treat the
paragraphs above as claims to test, not as findings.

## Item 0b — the destination is a decision, not a default

**Do not assume everything goes to SurrealDB.** Per `CLAUDE.md`, Lore is
tri-substrate: graph (Kùzu → SurrealDB), vector (LanceDB), **relational
(SQLite)**. SQLite already owns the outbox, migrations, audit and auth, and now
collections. It is a first-class destination, not a fallback.

For each subsystem, choose on shape and justify it in `DECISIONS.md`:
- **Graph-shaped** (nodes and edges, traversal, inheritance walks) → SurrealDB.
- **Tabular or queue-shaped** (rows, ordering, claim/complete semantics) → SQLite.

A durable work queue is a textbook SQLite case. Putting it in a graph store
because the old one happened to live in the graph store would repeat the exact
mistake `sqliteTableStorage.ts`'s header describes.

## Item 1 — collections: finish the job

- Confirm the SQLite backend is genuinely the default and complete.
- Build the **one-time migration helper** the code says is on the backlog:
  read tables from the Kùzu backend, write them to SQLite, verify row counts and
  schemas match, and refuse rather than half-migrate on any mismatch.
- Then **delete `KuzuTableStorage`** and the `LORE_TABLE_BACKEND=kuzu` branch.
  Leaving it means Kùzu stays importable, which defeats the acceptance test.
- If any real workspace on this machine has Kùzu-backed collection data, say so
  and stop before deleting — read-only detection is fine, migration of live data
  is an operator action.

## Item 2 — analytical projections

Establish whether this survives item 1. If it does, port it; if it does not,
record that it resolved and move on. Either way, state which — do not leave it
ambiguous.

## Item 3 — the approvals queue

Port `lore_pending_op` off Kùzu, destination chosen per item 0b. Preserve the
existing semantics exactly: whatever ordering, claiming and completion guarantees
the current store provides must hold in the new one, and be asserted. A queue
that loses or double-issues an approval is worse than a slow one.

Include a migration for existing rows, with the same refuse-don't-half-migrate
rule as item 1.

## Item 4 — ReBAC

`LoreRebacEdge` plus the group/parent inheritance walks and expiry filtering.

**This one has the most freedom and you should use it.** D-023 records that
graph-stored ReBAC has **no production consumers** — the only importers are
tests. So there is no compatibility burden: you can port it as-is, or
reimplement it properly, whichever is better.

Two things to carry forward rather than rediscover:
- Every query anchors on `LoreNode` endpoint ids (DEC-SURREAL-REBAC). Whatever
  you build must not repeat that coupling in a form that breaks when the graph
  substrate changes again.
- `grant()` used to report success having created nothing. Phase 3's amendment
  fixed it. Do not reintroduce that shape.

If this lands on SurrealDB alongside the graph, **D-023 needs revisiting** —
its stated reason ("it is non-functional on a Surreal-backed workspace") stops
being true. Update or retire the rule deliberately, with a decision entry; do
not just delete it to make the build pass.

## Item 5 — prove Kùzu is actually gone, and keep it gone

The end state is not "Kùzu is unused." It is "Kùzu cannot come back by
accident."

- A test that opens a workspace, exercises every subsystem, and asserts **no
  Kùzu database file exists** and **no kuzu-lite module was loaded**.
- Backup and restore must work on a Kùzu-free workspace — Phase 3 proved
  `.lore/` is treated as an opaque tree, so this should be free, but prove it.
- An architecture rule (D-024) that fails the build on any new `kuzu-lite`
  import outside whatever migration-only path still legitimately needs it.
- Whether kuzu-lite leaves `package.json` entirely is the last step and depends
  on whether migration helpers still need to read old data. State your
  recommendation; do not remove the dependency without saying so explicitly.

---

## Constraints

- **Never write under `~/.groundfloor/`.** Copy-first for any real data.
  Re-verify byte-identical at the end (922 files, the Phase 5 digest).
- **Do not touch the Atlas daemon** on `127.0.0.1:3848`.
- **Do not set `graphEngine: 'surreal'` on any real workspace.**
- kuzu-lite SIGSEGVs after ~12 database open/close cycles per process — one
  stage per process, and say so.
- File size budget: 500-line target, 800 hard cap.
- **No timing assertions.** If you measure, print the number; do not gate on it.

## Gate

1. `npm run build` — clean.
2. `npx tsc --noEmit` — clean.
3. `npm run test:arch` — clean, including D-022 and D-023 (and D-024 if added).
4. `npm test` — green, **run three times**, not once. Baseline at `a993d82` is
   **2691 assertions, parity 64/64**. Account for the delta.
5. `~/.groundfloor/` unmodified.

## Report back

- Item 0 first: which of my four claims held and which did not. If the scope is
  smaller or larger than described, say so before anything else.
- For each subsystem: destination chosen, why, and what the migration does.
- The acceptance test from the top: does a Kùzu-free workspace work end to end?
- What still holds Kùzu in place, if anything.
- Anything here you think is wrong.
