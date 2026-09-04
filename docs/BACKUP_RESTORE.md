# Backup & Restore

Disaster-recovery guide for Lore's per-workspace data. Covers the real
`lore backup` / `lore restore` commands, what they capture, a tested restore
drill, and RPO/RTO guidance.

Source of truth: `cli/commands/backup.ts`, `cli/commands/restore.ts`,
`engines/backup.ts`, `engines/restore.ts`. Every flag below exists in the CLI.

See also: [`OPERATIONS.md`](./OPERATIONS.md) (running the daemon) and
[`UPGRADE.md`](./UPGRADE.md) (schema migration, which has its own rollback story).

---

## What gets backed up

Each Lore **workspace** owns its own `.lore/` directory containing all three
substrates. A backup is a **coordinated, per-workspace snapshot** of that
directory, packaged as a single `.tar.gz`:

| Substrate | On disk | How it's captured |
| --- | --- | --- |
| **Graph** — SurrealDB (the only graph engine) | `surreal/` | Directory copy |
| **Relational** (SQLite) | `tables.sqlite` | SQLite serialize (concurrent-write-safe) |
| **Vector** (LanceDB) | `lancedb/` | Recursive directory copy |
| **Sidecar state** | `config.json`, schema caches, outbox, etc. | File / directory copy |

A `backup-manifest.json` (workspace name, timestamp, file list, warnings, source
path) is written into every tarball. Since NW-7h the manifest also carries
`schemaVersion: 2` and a `catalog` — a per-file SHA-256 + size list of everything
inside the staged tree. Restore **refuses** any tarball missing the manifest or
the `.lore/` directory, so a stray `.tar.gz` can't be mistaken for a Lore backup,
and a v2 manifest is **verified file-by-file against the catalog before any
restore step touches the live workspace.**

### Consistency caveat (read this)

The backup is **not a globally quiesced snapshot**. There is no daemon-side
write-mutex to acquire, so backup cannot truly pause concurrent writers. What it
does, in order:

1. Refuses to run at all while the local daemon answers `/api/health` (see
   "Daemon guard" below) — `--force` bypasses this for advanced/scripted use.
2. Drops a `BACKUP_IN_PROGRESS` sentinel in the staged tree (cleared before the
   tarball is sealed) so a concurrent admin operation can tell a backup is
   running.
3. Reads the SurrealDB graph store back through a real engine open and waits
   for it to stop changing on disk (see "Graph settle-and-verify" below), then
   captures each substrate — `tables.sqlite` via SQLite's serialize path
   (safe under concurrent writers), then everything else, with the graph
   store captured **last** and re-settled immediately before its copy. The
   LanceDB directory remains a **best-effort point-in-time copy** — a write
   that lands mid-copy may appear partially in the snapshot.
4. Opens the **staged copy** of the graph store and requires it report the
   same node count the source did. A graph directory copied mid-flush is a
   structurally valid, empty store, and this is the only check in the
   pipeline that can tell the difference — see "Graph settle-and-verify".
5. Computes a per-file SHA-256 catalog over the staged tree and embeds it in
   `backup-manifest.json`.
6. After the tarball is written, **re-extracts it into a verify-only temp dir
   and asserts every file matches the catalog**. Any mismatch — torn write,
   truncated tarball, swapped file, hash drift — fails the `lore backup`
   command with a precise reason; the bad tarball is deleted before the call
   returns, so the operator never sees a poisoned backup file.

In practice the graph mid-copy case is recovery-tolerant (the settle-and-verify
step above catches a torn mid-flush copy before the tarball seals, and the
consistency sweeper reconciles any remaining drift on the next pass after
restore), but a backup taken under heavy concurrent write load is **not** a
perfectly transactional image. LanceDB and
the sidecar files are still best-effort copies, and a write landing between
the graph settle and its copy can still tear them. For the
cleanest snapshot, take backups when
the workspace is idle, or stop the daemon first — which the daemon guard now
makes the default rather than a suggestion. A future hardening item is a
true quiesced snapshot via a daemon-side write-mutex; it is **not** implemented
today.

### Daemon guard

`lore backup` and `lore restore` both refuse to run while the local daemon
answers `http://127.0.0.1:<LORE_PORT||3847>/api/health`, printing instructions
to stop it (`launchctl bootout …`) first. This exists because both commands
now open the SurrealDB graph store directly to verify it — the same
single-writer directory lock the daemon holds — so running underneath a live
daemon either fails to open the store or, worse, succeeds against a directory
a second process is still writing to. Pass `--force` to bypass (tests /
one-shots only; do not use this as a routine way to back up a live daemon).

`lore restore` adds a second, narrower check even under `--force`-free normal
use: it also probes whether the **destination** graph store's lock is held by
anyone, independent of whether that holder is the Lore daemon (a forgotten CLI
session counts too).

### Graph settle-and-verify

`SurrealGraph.close()` awaits the driver's `close()`, but the driver only
frees the engine handle — it does not await surrealkv's WAL→sstable flush,
which lands ~10-25 ms **after** `close()` resolves and writes by the on-disk
path captured at open. A backup or restore that reuses that path within that
window (restore does, by design — see below) can have the old store's
deferred flush unlink the new store's WAL, leaving a structurally valid,
empty graph directory that every byte-level check in this pipeline treats as
fine.

Both commands now guard against this the same way: after closing (or before
copying) a SurrealDB store, wait — bounded to ~2s, polling every 25ms — until
its directory stops changing (`wal/` empty or the whole tree byte-and-mtime
stable across two polls), then open it read-only-in-intent and read back the
node count. Backup records that count as `graphNodeCount` in the manifest and
re-checks it against the staged copy before sealing the tarball; restore
re-reads the **restored** store after the swap and refuses to report success
if it is unreadable or its count disagrees with the manifest's. This is
bounded and best-effort by design — a store that never settles makes the
operation slower, never fatal — but the *verification* step is not optional:
a mismatch throws.

---

## `lore backup`

```bash
lore backup                          # active workspace → ./backups/
lore backup --workspace developer    # an explicit workspace
lore backup --all                    # every registered workspace
lore backup --out /srv/lore-backups  # explicit output dir (default ./backups)
lore backup --keep 14                # retention: keep N most recent (default 7)
```

### Flags

| Flag | Meaning | Default |
| --- | --- | --- |
| `--workspace <name>` | Back up one named workspace | active workspace |
| `--all` | Back up every registered workspace | — |
| `--out <dir>` | Output directory (created if missing) | `./backups` |
| `--keep <n>` | Retention count per workspace (positive integer) | `$LORE_BACKUP_KEEP` or `7` |
| `--force` | Bypass the daemon-running refusal (see "Daemon guard") | — |

### Behavior

- Refuses to run while the local daemon is up (`--force` bypasses) — see
  "Daemon guard" above.
- Output tarballs are named `lore-backup-<workspace>-<iso-timestamp>.tar.gz`.
- On success the command prints the tarball path, size in MB, file count,
  elapsed seconds, and — when the workspace has a SurrealDB graph store — the
  node count read back from the copy. Exit `0` on success.
- **Retention / rotation:** after a successful backup, older tarballs for the
  *same workspace* beyond `--keep` are pruned (newest kept). Pruning is
  per-workspace and matches the `lore-backup-<workspace>-` prefix, so it never
  deletes another workspace's tarballs sharing the same output dir. The default
  comes from `LORE_BACKUP_KEEP` (falls back to `7`). Pruning is best-effort —
  locked/permission-denied files are skipped silently.
- **`--all`** also copies `workspaces.json` into the output dir (as
  `workspaces-<iso>.json`) so a full restore can rebuild the workspace registry
  alongside the per-workspace tarballs. Per-workspace tarballs are independent: a
  failure on one workspace does not abort the rest; the command exits `2` if any
  workspace failed.

### Example: scheduled nightly backup of everything

```bash
# cron / launchd — every workspace, keep 14 days, off-box output dir
LORE_BACKUP_KEEP=14 lore backup --all --out /srv/lore-backups
```

Copy `/srv/lore-backups` off the host (rsync, object storage) for real DR — a
backup on the same disk does not survive disk loss.

---

## `lore restore`

```bash
lore restore <tarball> [--workspace <name>]
lore restore --all <dir>
```

| Argument / flag | Meaning |
| --- | --- |
| `<tarball>` (positional, required unless `--all`) | Path to a `lore-backup-*.tar.gz` |
| `--workspace <name>` | Target workspace to restore into (default: active) |
| `--all <dir>` | Restore every `lore-backup-*.tar.gz` in `<dir>`, each into the workspace named in **its own** manifest |
| `--force` | Bypass the daemon-running AND destination-lock refusals (see "Daemon guard") |
| `--allow-unverified` | Restore an archive whose source graph was never confirmed readable at backup time |
| `--allow-name-mismatch` | Restore an archive whose manifest names a **different** workspace than the one you're restoring into |

### Behavior

1. Refuses to run while the local daemon is up, or while the destination's
   graph store lock is held by anyone (`--force` bypasses both) — see
   "Daemon guard" above.
2. Validates the tarball exists and that the target workspace is known and its
   directory exists.
3. Stage-extracts the tarball into a temp dir, then verifies it contains both
   `.lore/` and `backup-manifest.json` — otherwise it refuses.
4. **Integrity-verifies the staged tree against the manifest catalog**
   (NW-7h, when `schemaVersion >= 2`). A file count, total-bytes, or per-file
   SHA-256 mismatch aborts the restore **before** the live `.lore/` is touched,
   so a corrupted backup cannot destroy an intact workspace. Pre-NW-7h
   tarballs (no catalog) skip this step for backwards compatibility.
5. **Compares the archive's recorded workspace name against the one you're
   restoring into.** `backup-manifest.json` carries a `workspace` field — the
   name `lore backup` was run against. If it disagrees with `--workspace`
   (or the active workspace), restore **refuses before touching anything**,
   naming both workspaces, unless `--allow-name-mismatch` is passed — in
   which case it proceeds and prints a loud warning. This catches the "wrong
   tarball" / "stale `--workspace` flag" mistake, which otherwise restores
   cleanly with no warning at all. Archives with no recorded `workspace`
   field (pre-3.19) proceed either way, with a one-line notice instead of a
   comparison they predate.
6. **Settles** any SurrealDB store already at the destination (see "Graph
   settle-and-verify" above), then **sidelines** any existing `.lore/` to
   `.lore.pre-restore-<iso>` in the same workspace directory (the rollback
   path), then moves the restored `.lore/` into place.
7. **Reads the restored graph store back** through a real engine open and
   refuses to report success if it is unreadable, or if its node count
   disagrees with the count the manifest recorded from the source — the
   rollback path from step 6 is named in the error so the operator can
   recover immediately.
8. Prints bytes restored, file count, elapsed time, the graph node count read
   back (when applicable), and the sidelined-prior path.

Restore is intentionally low-magic: it **does not start the daemon**, does not
validate substrate consistency, and does not run migrations. After a restore you
must **restart the daemon** yourself; the consistency sweeper then reconciles any
drift on its next pass.

### `--all <dir>` — restoring a whole backup directory

```bash
lore restore --all /srv/lore-backups
```

Restores every `lore-backup-*.tar.gz` found directly in `<dir>`, each into the
workspace **its own manifest** names (via the same `workspace` field the
name-mismatch guard above reads) — not the active workspace, and not a
workspace you name on the command line. An archive whose manifest carries no
`workspace` field is **skipped and reported**, never guessed onto some
workspace it may not belong to.

Each archive goes through the exact same single-archive path described above
— daemon guard, lock guard, unverified-source guard — applied independently
per archive. One archive failing (or being skipped) does not stop the rest,
same as `lore backup --all`'s per-workspace independence; the command exits
non-zero if anything failed or was skipped. `--force`, `--allow-unverified`,
and `--allow-name-mismatch` apply to every archive in the directory alike —
there is no per-archive override.

Use it opposite a `lore backup --all` output directory to rebuild a
multi-workspace install in one command; the `workspaces-<iso>.json` snapshot
from that `--all` backup documents which workspaces existed, for creating any
that no longer exist before restoring into them.

### Rollback

If the restore turns out wrong, the previous state is intact at
`.lore.pre-restore-<iso>`. To roll back: stop the daemon, move the current
`.lore/` aside, rename `.lore.pre-restore-<iso>` back to `.lore`, and restart.
Once you're confident the restore is good, delete the `.lore.pre-restore-*`
directory to reclaim disk.

---

## Tested restore drill

Run this periodically — a backup you have never restored is a hypothesis, not a
backup. Use a throwaway workspace so you never touch production data.

```bash
# 1. Take a fresh backup of the workspace you want to verify.
lore backup --workspace developer --out /tmp/dr-drill

# 2. Note the tarball path printed by the backup command, e.g.:
#    /tmp/dr-drill/lore-backup-developer-2026-06-13T...-...tar.gz

# 3. Create (or pick) a disposable target workspace and stop the daemon
#    so no writer holds the graph store's file handles during the swap.
#    (Use `lore workspaces` to list / create as appropriate.)

# 4. Restore into the disposable workspace.
lore restore /tmp/dr-drill/lore-backup-developer-<iso>.tar.gz --workspace dr-scratch

# 5. Restart the daemon, then confirm the restored graph looks right.
lore serve --http &      # or your normal supervisor
lore status              # node/edge counts for the active workspace
# `workspaces.perWorkspaceStats` is on the authenticated (full) /api/health
# body only — an anonymous call gets back the lite body with no such field.
# See docs/OPERATIONS.md's "GET /api/health" section for the split.
curl -s -H "Authorization: Bearer $(cat ~/.groundfloor/auth.token)" \
     http://localhost:3847/api/health | jq '.workspaces.perWorkspaceStats'

# 6. Clean up: remove the sidelined prior state and the scratch workspace.
#    rm -rf <workspace>/.lore.pre-restore-*
```

**Pass criteria:** restore exits `0`, `lore status` / `/api/health` report
node/edge counts consistent with the source workspace, and a `recall` against the
restored workspace returns expected nodes.

---

## RPO / RTO guidance

These are operational targets you set with the schedule and topology — Lore does
not enforce them. The numbers below are realistic given the tooling.

### RPO (Recovery Point Objective) — how much data you can afford to lose

RPO is bounded by your **backup interval**. Lore has no continuous/incremental
backup; each `lore backup` is a full snapshot.

| Backup cadence | Effective RPO |
| --- | --- |
| Nightly | up to ~24h |
| Hourly | up to ~1h |
| On-demand before risky ops | near-zero for that change |

Tighten RPO by running `lore backup --all` more frequently. Because backups are
not globally quiesced (see caveat above), the *practical* recovery point is "the
last backup whose post-write catalog verification passed, minus any writes in
flight during that backup." The verification step (NW-7h) guarantees that a
**successful** `lore backup` exit code means the tarball is byte-for-byte
consistent with what was staged — failures are surfaced loudly, not silently
producing a corrupt archive.

**Always run a backup immediately before a schema migration or upgrade** — that
is your zero-RPO rollback for the change (see [`UPGRADE.md`](./UPGRADE.md)).

### RTO (Recovery Time Objective) — how fast you can be back up

RTO is dominated by the restore copy time plus daemon restart:

1. Fetch the tarball from off-box storage (network-bound).
2. `lore restore <tarball>` — extract + directory copy; seconds to minutes
   depending on workspace size (LanceDB vector volume dominates).
3. Restart the daemon and let the consistency sweeper run its first pass.

For typical workspace sizes (sub-GB), expect single-digit-minute RTO once the
tarball is local. Pre-staging recent backups on fast local storage is the main
lever for cutting RTO.

### Recommendations

- Keep at least `--keep 7` locally and replicate tarballs off-host.
- Run the **restore drill** above on a schedule so RTO is measured, not assumed.
- Store the `workspaces-<iso>.json` from `--all` backups so you can rebuild the
  registry for a multi-workspace recovery.
