# Adopting Lore 3.20.0 in Atlas

Atlas embeds Lore in-process (`createLore()`, never passes `ownsProcess: true`
— confirmed by grep, `../groundfloor-atlas`), currently vendors
`vendor/groundfloor-lore-3.19.1.tgz`, and is under a **FIXES-ONLY freeze**:
new Lore capability surface does not get adopted just because it shipped,
only bug fixes and behaviour Atlas already relies on. This note tells you
what 3.20.0 gives you automatically under that freeze, what stays off until
someone deliberately turns it on, and how to get the memory numbers this
release actually measured for an embedded host like Atlas.

This file is read-only with respect to `../groundfloor-atlas` and
`../ATLAS-UPGRADE-TO-LORE-3.18.2.md` — nothing there was changed to write
this note; it mirrors that doc's adoption procedure for this release.

## What you get automatically (pure fixes, no action required)

These are bug fixes to code paths Atlas already exercises. Once you bump the
vendored tarball, they apply with no config change:

- **`VerbatimStore.close()` now actually closes its LanceDB write table and
  connection**, instead of only dereferencing them for GC. This is the fix
  `LORE-ASK-VECTOR-CLOSE-AWAIT.md` asked for — every `close()` call Atlas
  already makes (including through `WorkspaceVerbatimResolver.closeAll()` at
  shutdown) now returns the two handles it was silently leaking before.
  **This one is default-on** — see "The one default-on behaviour change"
  below, because it is not purely passive: it now waits on in-flight writes.
- **`LoadJobsStore`, the bulk-loader adapter, and Arcade provisioning now
  close their `better-sqlite3` handles.** If Atlas uses bulk load jobs or
  Arcade-mode provisioning, this closes fd leaks you were paying for
  regardless of any option.
- **The boot verbatim store is closed structurally at shutdown**, not by an
  `instanceof` check that could miss it depending on construction path.
- **`WorkspaceVerbatimResolver`'s home directory now matches the actual
  `dataDir` Atlas passes**, instead of drifting to the resolver's own
  default home. This only bit embedded hosts with a non-default `dataDir` —
  which is Atlas's normal configuration (`<ATLAS_HOME>/lore-data/<workspace>`)
  — so this is a real fix for you, not a hypothetical one.
- **Background retention/consistency sweeps no longer reset a workspace's
  idle-eviction clock.** This one only matters once you opt into eviction
  (below) — noted here for completeness, not because it changes anything on
  its own.

None of these need a new `CreateLoreOptions` field. They are simply what
`close()` / shutdown / provisioning do differently on the inside.

## What is opt-in and stays OFF for Atlas under the freeze

3.20.0 adds four pieces of new surface area. All four default to 3.19.1
behaviour and require Atlas to explicitly pass a new option — under the
FIXES-ONLY freeze, **do not turn these on as part of the version bump
itself**. If/when Atlas wants any of them, that is a separate, deliberate
change with its own review, not something that rides along on a tarball
swap.

| New surface | Option | Default if omitted |
|---|---|---|
| Idle eviction for verbatim stores | `getVerbatimResolver().evictIdle(...)` / `.closeWorkspace(...)` / `.openCount()`, `LORE_VERBATIM_IDLE_TTL_MS`, `LORE_VERBATIM_SWEEP_MS` | No sweep runs for Atlas at all (see below — this isn't really optional the way the other three are) |
| Vector-store role scoping | `CreateLoreOptions.vectorStoreRole` | `'both'` — today's 18-handle behaviour, unchanged |
| Per-store search-worker policy | `CreateLoreOptions.searchWorkerPolicy` | The existing global `LORE_SEARCH_WORKER` env gate, unchanged |
| Embedding pipeline idle-unload | `LORE_EMBED_IDLE_UNLOAD_MS` | `0` — never unload, unchanged |
| Injected `EmbeddingProvider` | `CreateLoreOptions.embeddingProvider` | Local ONNX pipeline, unchanged (Atlas already provides its own embedding path outside this option, so this is unlikely to be relevant to you at all) |

## The one default-on behaviour change

**`VerbatimStore.close()`'s native-handle close is on by default** (see
above) — this is the one place 3.20.0 changes what already-called code does,
rather than adding something new to call. Concretely: `close()` now drains
in-flight writes (waits up to 5 s) before releasing the LanceDB table and
connection handles, instead of nulling references immediately. For Atlas
this means a `close()` call can now take up to 5 s longer under write
contention where it previously returned immediately (and leaked); it does
not change `close()`'s success/failure contract (still idempotent, still
doesn't throw on a stuck write — it just leaves that store's handles open
rather than risk a crash, and logs).

If this default-on behaviour causes a problem for Atlas specifically (a
shutdown-time latency budget, for example), the kill switch is
`LORE_VERBATIM_NATIVE_CLOSE=0`, which reverts to the exact 3.19.1
dereference-only close. That env var is already allowlisted in
`security/envScrub.ts`, so it passes through an embedded host's environment
scrub without any code change on Atlas's side.

## How to adopt (mirrors `../ATLAS-UPGRADE-TO-LORE-3.18.2.md`)

1. Build the tarball (see the release's own tarball-verification record in
   this repo — `npm pack` run in an isolated worktree, never in this
   checkout's own `dist/`) and drop it into Atlas's `vendor/` as
   `groundfloor-lore-3.20.0.tgz`, alongside the existing 3.19.1 one (delete
   the old one once the upgrade sticks, per the 3.18.2 note's own
   housekeeping step).
2. Point `package.json` at it:
   `"@groundfloor/lore": "file:vendor/groundfloor-lore-3.20.0.tgz"`
3. `npm install`.
4. **Assert what actually got installed before testing anything** — the
   3.18.2 note flagged a real incident where `package.json` and
   `node_modules` disagreed. Run:
   `grep -m1 '"version"' node_modules/@groundfloor/lore/package.json` — it
   must say `3.20.0`.
5. Run Atlas's own Lore-embedding test suite. Nothing above changes any
   existing call's signature or return shape, so a green run before the bump
   should stay green after it; a difference here means investigate before
   shipping, not silence it.
6. Under the FIXES-ONLY freeze, stop here. Do not add any of the opt-in
   options from the table above in the same change — file that as its own
   follow-up if/when Atlas decides it wants idle eviction or a role-scoped
   store.

## Getting the memory wins Atlas actually cares about

The headline number for Atlas (~145 MB per open workspace, mostly
SurrealDB) is **not** fixed by adopting 3.20.0 alone — see "the honest
expectation" below. The wins 3.20.0 does offer an embedded host require
Atlas to drive them itself, because **the daemon's own sweep never runs for
Atlas.** `WorkspaceVerbatimResolver`'s idle-eviction sweep is gated on
`daemonTimersEnabled(ownsProcess, mode)` — the same ownership gate
documented in this repo's `CLAUDE.md` that also gates the parent-env scrub
and the native-pool crash handlers. Atlas never passes `ownsProcess: true`
(by design — Atlas does not own this process's lifecycle, the host
application does), so that gate evaluates false for Atlas today and always
has, and will continue to for any future Lore version that keeps this
ownership model. There is no configuration that turns the daemon sweep on
for an embedded host; it is architecturally scoped to the process owner.

If Atlas wants the vector-store idle-eviction win, it must call the
resolver itself, on whatever cadence fits Atlas's own request/idle pattern:

```ts
const resolver = lore._daemon.getVerbatimResolver();
if (resolver) {
    // e.g. on Atlas's own periodic tick, or after a request completes:
    resolver.evictIdle(Date.now(), IDLE_MS);
    // resolver.openCount() to observe how many stores are currently open
    // resolver.closeWorkspace(name) to force-close one specific workspace
}
```

A store with queued embed or outbox work is never evicted regardless of how
this is driven, and a later access reopens an evicted store transparently —
same contract whether the daemon or Atlas is the one calling `evictIdle`.

This is a deliberate design choice on Lore's side, not a gap: an embedded
host is better positioned than Lore to know its own idle windows (Atlas
knows when an IDE session actually went quiet; Lore does not), so eviction
policy for embedded hosts is exposed as a callable, not a background timer
Lore would have to guess the right interval for.

## The honest expectation — what this release does NOT give back

Per-workspace SurrealDB memory (**~100 MB resident, and 3 open file
descriptors, per store open — including a reopen of the same directory**)
is **not returned by 3.20.0, and cannot be, from inside Lore**. This is
`docs/PERFORMANCE-MEMORY.md` §9's verdict: `@surrealdb/node@3.0.3`'s
`Datastore` is never destroyed by any call reachable from JS, so nothing
short of process exit reclaims it — Lore's `close()` is correct and
complete on its side; the addon simply does not release what it allocated.

**This makes graph-store idle eviction net-negative for Atlas specifically,
and 3.20.0 deliberately does not offer it**: keeping a graph open costs
~100 MB once; evicting and reopening it costs another ~100 MB per reopen,
without bound, for a driver that never gives the previous ~100 MB back. Do
not build an eviction loop against the graph half expecting it to help —
only the vector (LanceDB) half is worth evicting, per the section above.

**Follow-up (`pr/3.20.0-21-graph-idle-unload-off`):** this exact reasoning
is why the LOCAL DAEMON's own `LORE_REGISTRY_IDLE_TTL_MS` default changed
to `0` (disabled) later in the 3.20.0 stack — a daemon that owned its
process used to evict-then-reopen idle graphs every 30 min by default,
paying this same net-negative cost the daemon itself never needed to pay.
This does not change anything for Atlas (embedded already never ran that
sweep — `autoEvict: false`, per "What you get automatically" above), but if
Atlas ever adopts a later tarball, do not read "the daemon's default
changed" as a signal to reconsider graph eviction for the embedded path;
the underlying driver behavior this section describes is unchanged.

If Atlas's ~145 MB-per-workspace number needs to come down further, the
routes are outside what a Lore version bump can provide: hosting SurrealDB
(and optionally the embedding model) in a disposable child process — the
same pattern `VerbatimSearchWorkerProxy` already uses for LanceDB search —
is the only route to "zero resident when idle" for the graph half,
mentioned as a "what Lore will do next" item in
`docs/ANSWERS-FOR-HOSTS-2026-09.md`, not something 3.20.0 ships.

Similarly, the embedding pipeline's idle-unload (`LORE_EMBED_IDLE_UNLOAD_MS`
/ `releaseLocalEmbeddingPipeline()`) frees the JS-side cache slot but
**returns approximately zero RSS** (§10.3 — RSS rose slightly across every
measured release, never fell back toward baseline). It ships off by default
for exactly this reason; do not turn it on expecting a memory win on this
platform/runtime combination. It is unlikely to matter to Atlas regardless,
since Atlas is not known to route through Lore's local ONNX pipeline.

See `docs/ANSWERS-FOR-HOSTS-2026-09.md` for the full seven-question
answer set this release was measured against, and
`docs/PERFORMANCE-MEMORY.md` §9-§12 for the underlying measurements cited
throughout this note.
