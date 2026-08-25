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
| **Graph** — SurrealDB (default as of v3.13.0) | `surreal/` | Directory copy |
| **Graph** — Kùzu (legacy, per-workspace `graphEngine: kuzu`) | `graph`, `graph.wal` | File copy |
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

1. Drops a `BACKUP_IN_PROGRESS` sentinel in the staged tree (cleared before the
   tarball is sealed) so a concurrent admin operation can tell a backup is
   running.
2. Captures each substrate. `tables.sqlite` uses SQLite's serialize path, which
   is safe under concurrent writers. The graph store (SurrealDB by default;
   Kùzu for workspaces pinned to `graphEngine: kuzu`) and the LanceDB
   directory are **best-effort point-in-time copies** — a write that lands
   mid-copy may appear partially in the snapshot.
3. Computes a per-file SHA-256 catalog over the staged tree and embeds it in
   `backup-manifest.json`.
4. After the tarball is written, **re-extracts it into a verify-only temp dir
   and asserts every file matches the catalog**. Any mismatch — torn write,
   truncated tarball, swapped file, hash drift — fails the `lore backup`
   command with a precise reason; the bad tarball is deleted before the call
   returns, so the operator never sees a poisoned backup file.

In practice the graph mid-copy case is recovery-tolerant (Kùzu's WAL carries
the missing tail on legacy workspaces, and the consistency sweeper reconciles
drift on the next pass after restore), but a backup taken under heavy
concurrent write load is **not** a perfectly transactional image. For the
cleanest snapshot, take backups when
the workspace is idle, or stop the daemon first. A future hardening item is a
true quiesced snapshot via a daemon-side write-mutex; it is **not** implemented
today.

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

### Behavior

- Output tarballs are named `lore-backup-<workspace>-<iso-timestamp>.tar.gz`.
- On success the command prints the tarball path, size in MB, file count, and
  elapsed seconds. Exit `0` on success.
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
```

| Argument / flag | Meaning |
| --- | --- |
| `<tarball>` (positional, required) | Path to a `lore-backup-*.tar.gz` |
| `--workspace <name>` | Target workspace to restore into (default: active) |

### Behavior

1. Validates the tarball exists and that the target workspace is known and its
   directory exists.
2. Stage-extracts the tarball into a temp dir, then verifies it contains both
   `.lore/` and `backup-manifest.json` — otherwise it refuses.
3. **Integrity-verifies the staged tree against the manifest catalog**
   (NW-7h, when `schemaVersion >= 2`). A file count, total-bytes, or per-file
   SHA-256 mismatch aborts the restore **before** the live `.lore/` is touched,
   so a corrupted backup cannot destroy an intact workspace. Pre-NW-7h
   tarballs (no catalog) skip this step for backwards compatibility.
4. **Sidelines** any existing `.lore/` to `.lore.pre-restore-<iso>` in the same
   workspace directory (the rollback path), then moves the restored `.lore/` into
   place.
5. Prints bytes restored, file count, elapsed time, and the sidelined-prior path.

Restore is intentionally low-magic: it **does not start the daemon**, does not
validate substrate consistency, and does not run migrations. After a restore you
must **restart the daemon** yourself; the consistency sweeper then reconciles any
drift on its next pass.

### Rollback

If the restore turns out wrong, the previous state is intact at
`.lore.pre-restore-<iso>`. To roll back: stop the daemon, move the current
`.lore/` aside, rename `.lore.pre-restore-<iso>` back to `.lore`, and restart.
Once you're confident the restore is good, delete the `.lore.pre-restore-*`
directory to reclaim disk.

> Caveat: `lore restore` operates on **one workspace at a time**. There is no
> `--all` restore. To rebuild a multi-workspace install, restore each workspace
> tarball individually; the `workspaces-<iso>.json` snapshot from a `--all` backup
> documents which workspaces existed.

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
curl -s http://localhost:3847/api/health | jq '.workspaces.perWorkspaceStats'

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
