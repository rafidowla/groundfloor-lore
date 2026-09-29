# Migrating to Lore 3.25.x

For embedded hosts (Atlas, MIRA, PM Helper, nirman-tapestry) and daemon
operators upgrading from 3.24.x. Covers the storage-growth fix: no-op version
rows, an optional per-type history policy, opt-in age-based pruning, outbox
prune-on-open, and the offline reclaim tool. See also
[`CHANGELOG.md`](../CHANGELOG.md) 3.25.0 entry.

**Why this matters:** on Atlas's live store (2026-09-28), 75 workspace data
roots under `~/.groundfloor/atlas/lore-data/` totaled 14.3 GB — 50%
`.lore/versions.sqlite` (node version history), 27% `.lore/outbox.sqlite`,
17% Surreal graph, 3% LanceDB. Most of the two SQLite files' bytes were
avoidable without deleting any history: no-op version rows recorded on every
upsert regardless of content change, and outbox rows that were replicated but
never vacuumed away.

## 0. Behaviour change: history deletion is opt-in

**Version history is never deleted by age unless you explicitly enable it.**
This is true for embedded hosts and for the daemon.

- The daemon used to prune version history after 90 days by default. **It no
  longer does.** If you relied on that, opt in (below).
- When enabled, the default retention is **7 years (2557 days)**, not 90.
- Still on by default, unchanged: the no-op version skip (a row identical to
  the prior state is not recorded) and the outbox prune of `replicated` rows.

Enable it, only if you want it:

```ts
createLore({
  versionHistory: { pruning: { enabled: true /* retentionDays: 2557 */ } },
})
```

Daemon: `LORE_VERSION_PRUNE_ENABLED=1` (retention defaults to 2557 days), or
set `LORE_VERSION_RETENTION_DAYS=<n>` explicitly, which enables pruning at that
value and logs a one-time startup notice. `LORE_VERSION_PRUNE_SCHEDULE_DISABLED=1`
remains a kill switch. `retentionDaysByType` applies only when pruning is
enabled.

**Check what is in force**, read-only: `lore.getVersionHistoryPolicy()`, the
`get_version_history_policy` MCP tool, or `GET /api/version-history/policy`.
Nothing can change the policy through MCP or REST; it is set only by host
config or the daemon environment.

## 1. Nothing is required in `createLore()`

Hosts need no new option to upgrade. Atlas keeps its code-graph history: do
**not** add `skipTypes` for the `code_*` types. `skipTypes` remains available
as an opt-in for a host that genuinely does not want history recorded for a
node type; it is not a recommendation.

```ts
createLore({
  versionHistory: {
    skipTypes: ['some_disposable_type'],       // optional, host's choice
    retentionDaysByType: { some_type: 365 },   // only when pruning is enabled
  },
})
```

Daemon operators can set `skipTypes` with the comma-separated
`LORE_VERSION_SKIP_TYPES` env var; an explicit option always wins.

## 2. What runs by itself in embedded hosts

- **On open:** a deferred, zero-delay sweep prunes finished
  (`status='replicated'`) outbox rows older than the retention threshold,
  looping in bounded batches. Always on.
- **Version-history sweep:** runs only if you enabled pruning (section 0). It
  runs in bounded, yielding batches and reclaims space online via
  `incrementalVacuum()`. With pruning disabled (the default) it is not
  scheduled and deletes nothing.

**Existing files do not shrink from this alone.** The online sweepers use
`incrementalVacuum()`, which only reclaims pages on a file that already has
`auto_vacuum=INCREMENTAL` — true for new files created under 3.25, false for
every file that predates it. An existing large `versions.sqlite` or
`outbox.sqlite` needs the one-time offline reclaim below.

## 3. One-time reclaim, per data root

For each existing data root (each Atlas workspace, each MIRA/PM Helper data
dir):

1. **Stop the host** — dispose its `Lore` instance, or stop the process
   entirely. The tool refuses a held root (below), but that is a safety net,
   not a substitute.
2. **Back up the root.** A dry run is not guaranteed byte-for-byte identical
   on disk: opening a pre-3.25 file applies the same one-time schema upgrade
   (a new partial index) the host's next open would apply.
3. **Dry run first:**
   ```
   lore maintain storage --data-dir <root> --dry-run
   ```
4. **Then run it for real**, same flags minus `--dry-run`:
   ```
   lore maintain storage --data-dir <root>
   ```
   The default run does three things, none of which deletes history by age:
   drops exact no-op `node_versions` rows (dedupe), prunes `replicated`
   outbox receipts, then converts both files to `auto_vacuum=INCREMENTAL` and
   runs a full `VACUUM`.

Deletion is explicit, and never part of a default run:
- `--prune-older-than <days>` deletes version history older than that many
  days (protected rows are kept).
- `--skip-types <csv>` deletes existing version rows of those node types.

`lore maintain storage --help` lists all flags.

**It refuses to run** in two cases:
- **The data root is in use** — detected on every layout, including an idle
  host with no in-flight write.
- **Not enough free disk for the VACUUM step** — needs about 1.1x the file's
  size as scratch space; refuses with `ReclaimInsufficientDiskSpaceError`.

Programmatic form: `reclaimStorage({ dataDir, dryRun?, pruneOlderThanDays?,
skipTypes? })`.

## 4. Measured result (default reclaim, no history deleted)

Run on write-protected copies of two real data roots (copied first; sources
never modified; copies discarded after measuring), with **default options**:
no `--skip-types`, no `--prune-older-than`. Sizes in MB (10^6 bytes).

| root | file | before | after | reclaimed |
|---|---|---:|---:|---:|
| groundfloor-atlas | `versions.sqlite` | 1356.4 MB | 114.5 MB | 1241.9 MB (91.6%) — 291,052 no-op rows deduped, 0 rows deleted by age |
| groundfloor-atlas | `outbox.sqlite` | 482.5 MB | 17.6 MB | 464.9 MB (96.4%) — 268 replicated rows pruned; the rest is VACUUM/freelist cleanup |
| nirman-harness | `versions.sqlite` | 464.3 MB | 151.1 MB | 313.2 MB (67.5%) — 72,665 no-op rows deduped, 0 rows deleted by age |
| nirman-harness | `outbox.sqlite` | 457.6 MB | 0.6 MB | 457.0 MB (99.9%) — 144,605 replicated rows pruned |

Deleting nothing by age keeps roughly 114 MB and 151 MB of real version
history that a `skipTypes`/90-day run would have removed. That is the cost of
keeping history by default.

The `outbox.sqlite` dry-run estimate can under-report when the gain is mostly
VACUUM-only freelist cleanup, since VACUUM never runs in dry-run mode. Treat
the dry-run report as a lower bound.

## 5. Checklist

1. Bump the vendored tarball to 3.25.0 (copy into `vendor/`, update the
   `@groundfloor/lore` line, `npm install`, commit).
2. Decide whether you want age-based deletion. If not, do nothing: history is
   kept. If yes, enable it (section 0); retention defaults to 7 years.
3. Daemon operators who relied on the old 90-day default: set
   `LORE_VERSION_PRUNE_ENABLED=1` (and optionally `LORE_VERSION_RETENTION_DAYS`).
4. For every existing data root: stop the host, back it up, dry-run, then run
   `lore maintain storage` for real — section 3. This is the only step that
   actually shrinks existing files on disk.
