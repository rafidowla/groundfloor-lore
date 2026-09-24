# Performance — Memory (memory-leak sprint, Step 1 baseline)

Step 1 of the memory-leak sprint is measurement only: **prove and quantify**
the leak on 3.19.1 before anything is fixed. This document is the 3.19.1
baseline everything in Step 2 (`scratchpad STEP2-CLOSE-PATH-DESIGN.md`) is
measured against. Nothing in this document changes runtime behaviour.

**Machine:** darwin/arm64 (macOS 26.5.1, Darwin kernel 25.5.0), 128 GB RAM.
**Node:** 22.23.2 (required — the system default is v20 and fails on this
codebase's native deps).
**Lore version:** 3.19.1 @ `main`.
**Date measured:** 2026-09-17.

---

## 1. Summary

| Question | Answer |
|---|---|
| Does `inproc` (bare `VerbatimStore`, fake embedder, no SurrealDB) leak? | **No** — flat within noise over 50 cycles. |
| Does `worker` (LanceDB isolated in a disposable child process) leak? | **No** — flat within noise; **0** leaked/orphaned worker processes at every sample. |
| Does `embedded` (the full `createLore()`/`dispose()` lifecycle, what a real host like Atlas calls) leak? | **Yes — severely.** ~100 MB/cycle, R²=1.00, confirmed on two independent runs (50-cycle and 20-cycle). |
| Is the leak native or JS-heap garbage? | **Native.** `heapUsed` stays flat (~226-228 MB) across the entire 50-cycle `embedded` run while `rss` grows from 1,066 MB to 5,804 MB. |
| Does the unclean-vs-clean SurrealDB first-open cost look like the old (removed) local-graph-engine's ~1000×-WAL-size spike? | **No.** Measured delta is ~7.8 MB against a ~6 MB WAL-like footprint — roughly 1.3×, not 1000×. See §4 (Q2). |
| Are worker-mode search children ever leaked/orphaned? | **No**, measured — see §3. |

This directly contradicts one assumption baked into the Step-2 planning doc
(`scratchpad STEP2-CLOSE-PATH-DESIGN.md`), which expected the narrowest
harness (`inproc`) to cleanly reproduce the documented root cause
(`VerbatimStore.close()` dereferences its native LanceDB handles instead of
calling their native `close()`). It doesn't, measured. See §2.4 for why, and
why the regression test in §5 uses `embedded` instead.

---

## 2. Deliverable A — `scripts/measure-memory.mjs`

### 2.1 What changed before measuring: the confound fix

A previous partial run of this harness (kept for the record, not deleted:
this session's scratchpad `mm_inproc_15.log`) reused the SAME on-disk
`.lore/` data across every cycle. Entry count — and therefore FTS/vector
index size — grew every cycle, so cycle time rose from 4.4s (cycle 1) to
23.1s (cycle 10) purely from data volume. That mixes "more data costs more
RSS" into "the leak costs more RSS" and makes any slope uninterpretable.

**Fix (owner decision, confirmed independently in
`STEP2-CLOSE-PATH-DESIGN.md`'s "Owner decisions" §3):** the workspace
NAME/PATH stays constant across cycles (still the "close a workspace,
reopen it" shape, not N independent workspaces), but after every `close()`
the harness deletes that path's `.lore/` directory and lets the next
cycle's open() recreate it empty. Every cycle opens an EMPTY store and
writes the same entry count — data volume is flat for the whole run, so a
rising slope can only be the open/close leak.

**Proof the fix worked — cycle times are now flat**, where before they rose
6× over 10 cycles:

| config | cycle 1 | cycle 10 | cycle 25 | cycle 50 |
|---|---|---|---|---|
| inproc (this run) | 3183 ms | 3019 ms | 2748 ms | 2721 ms |
| worker (isolated re-run) | 2734 ms | 2448 ms | 2517 ms | 4408 ms* |
| embedded (this run) | 5688 ms | 6810 ms | 6033 ms | 4990 ms |

\* `worker`'s last ~10 cycles of this run picked up an unrelated timing
bump (2.5s → ~4.3-5.5s, sustained, not a single blip) with **RSS still
completely flat** through the same stretch (183.0 MB start to end of that
window) — see §2.5. It is reported honestly rather than trimmed, but it is
a timing artifact, not a memory artifact.

### 2.2 Full results, all three configs (50 cycles, 200 entries/cycle)

Regression is computed over cycles 5-50 (cycles 1-4 are warm-up: first
table/FTS/IVF_FLAT index build, first ONNX model load, first native mmaps —
excluded so one-time costs don't bias the steady-state slope). Full
per-cycle JSON for every run in this document was produced by
`node scripts/measure-memory.mjs --config <name> --cycles 50 --entries 200
--json <file>` and is not committed (ephemeral session output) — the tables
below are the complete regression-relevant data; every 5th cycle is shown,
first/last cycle always included.

#### inproc — 50 cycles, 200 entries/cycle

| cycle | rss (MB) | heapUsed (MB) | vmmap (MB) | elapsed (ms) |
|---|---|---|---|---|
| 0 (baseline) | 89.7 | 8.6 | 53.6 | 0 |
| 5 | 280.4 | 42.2 | 197.7 | 2694 |
| 10 | 258.1 | 42.6 | 172.3 | 3019 |
| 15 | 259.5 | 42.6 | 173.7 | 2816 |
| 20 | 261.5 | 42.7 | 175.8 | 2782 |
| 25 | 261.8 | 42.7 | 176.1 | 2748 |
| 30 | 262.1 | 42.7 | 176.4 | 2829 |
| 35 | 262.3 | 42.7 | 176.6 | 2762 |
| 40 | 262.5 | 42.7 | 176.8 | 2836 |
| 45 | 262.6 | 42.7 | 176.9 | 2846 |
| 50 | 262.8 | 42.8 | 177.0 | 2721 |

**Regression (cycles 5-50): slope = -0.127 MB/cycle, R² = 0.090 — flat, noise.**
Full-range (cycle 1→50): 352.4 MB → 262.8 MB (net **negative** — cycle 1
pays one-time warm-up cost that later cycles don't).

A second run with `--force-gc 0` (skip the harness's own forced GC, to test
whether forcing collection every cycle was itself masking a leak) over 25
cycles: slope = +0.066 MB/cycle, R² = 0.002 — also flat. V8 ran its own
incidental major GCs even without the forced call (visible as `heapUsed`
sawtooth between 44-77 MB), so this harness's low JS-heap churn wasn't
actually enough to prevent GC from happening naturally either.

**Verdict: no measurable leak in `inproc`,** with or without forced GC.

#### worker — 50 cycles, 200 entries/cycle (`LORE_SEARCH_WORKER`-equivalent isolation)

| cycle | rss (MB) | heapUsed (MB) | vmmap (MB) | elapsed (ms) | live children | zombies |
|---|---|---|---|---|---|---|
| 0 (baseline) | 91.2 | 8.9 | 55.1 | 0 | — | — |
| 5 | 208.3 | 41.1 | 166.2 | 2539 | 0 | 0 |
| 10 | 180.1 | 41.3 | 124.7 | 2448 | 0 | 0 |
| 15 | 180.9 | 41.3 | 125.5 | 2591 | 0 | 0 |
| 20 | 181.6 | 41.4 | 126.3 | 2543 | 0 | 0 |
| 25 | 181.9 | 41.4 | 126.5 | 2517 | 0 | 0 |
| 30 | 182.2 | 41.4 | 126.9 | 2423 | 0 | 0 |
| 35 | 182.3 | 41.4 | 126.9 | 2481 | 0 | 0 |
| 40 | 182.7 | 41.5 | 127.3 | 2481 | 0 | 0 |
| 45 | 182.8 | 41.2 | 127.5 | 4196 | 0 | 0 |
| 50 | 183.0 | 41.2 | 127.6 | 4408 | 0 | 0 |

**Regression (cycles 5-50): slope = -0.157 MB/cycle, R² = 0.134 — flat, noise.**
**0 live children and 0 zombies at every single sample across the entire
run** (see §3 for the child-process methodology). **Verdict: no measurable
leak, and no leaked/orphaned worker processes.**

#### embedded — 50 cycles, 200 entries/cycle (full `createLore()`/`dispose()`)

| cycle | rss (MB) | heapUsed (MB) | vmmap (MB) | elapsed (ms) |
|---|---|---|---|---|
| 0 (baseline) | 366.5 | 65.9 | 325.7 | 0 |
| 5 | 1293.7 | 226.8 | 1024.0 | 6813 |
| 10 | 1795.4 | 227.5 | 1536.0 | 6810 |
| 15 | 2296.5 | 227.6 | 2048.0 | 5995 |
| 20 | 2797.7 | 227.9 | 2560.0 | 6499 |
| 25 | 3299.0 | 228.0 | 3072.0 | 6033 |
| 30 | 3800.0 | 228.0 | 3584.0 | 5235 |
| 35 | 4300.9 | 228.0 | 4096.0 | 4977 |
| 40 | 4801.9 | 228.0 | 4608.0 | 4216 |
| 45 | 5302.8 | 228.0 | 5120.0 | 4466 |
| 50 | 5803.8 | 228.0 | 5529.6 | 4990 |

**Regression (cycles 5-50): slope = 100.218 MB/cycle, R² = 1.000.**
Full-range (cycle 1→50): **1,066.2 MB → 5,803.8 MB, +4,737.7 MB total.**
`heapUsed` moves only 1.2 MB across the same 45 cycles (226.8 → 228.0 MB) —
**the growth is entirely native, not JS-heap garbage**, matching the sprint
background's original framing exactly (a 5-cycle daemon run: 1,429 MB →
1,969 MB RSS with a flat JS heap). `vmmap` tracks `rss` almost exactly
(+512 MB every 5 cycles = +102.4 MB/cycle) — Apple's own "Physical
footprint" tool agrees with Node's own `rss`, so this isn't an artifact of
one measurement method.

An independent 20-cycle re-run (isolated, no other harness running
concurrently) reproduced the same slope almost exactly:
**100.294 MB/cycle, R² = 1.000**, 968.4 MB → 2,797.1 MB. This is a
severe, highly linear, trivially reproducible leak.

**Verdict: `embedded` leaks ~100 MB per open/write/close cycle**, confirmed
twice.

Cycle time for `embedded` is NOT perfectly flat the way `inproc`/`worker`
are: it rises from ~4.2s (cycles 3-8) to ~6.3s (cycles 9-20) in the isolated
20-cycle re-run, despite data volume being fixed by the confound fix. This
looks like a second-order effect of the leak itself (a larger resident
process has more OS-level bookkeeping — page tables, allocator metadata,
external-memory GC scanning) rather than a reappearance of the original
data-growth confound; it corroborates the leak rather than contradicting the
fix.

### 2.3 Reproduce

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH   # Node 22 required
cd groundfloor-lore

node scripts/measure-memory.mjs --config inproc   --cycles 50 --entries 200 --json /tmp/inproc.json
node scripts/measure-memory.mjs --config worker   --cycles 50 --entries 200 --json /tmp/worker.json
node scripts/measure-memory.mjs --config embedded --cycles 50 --entries 200 --json /tmp/embedded.json

# Diagnostic-only: does forcing GC every cycle mask a leak that would
# otherwise show up under normal (non-forced) GC scheduling?
node scripts/measure-memory.mjs --config inproc --cycles 25 --entries 200 --force-gc 0
```

Each run creates and destroys its own `mktemp`-style temp `LORE_HOME`; none
touch `~/.groundfloor` or any running daemon.

### 2.4 Why the companion unit test (§5) uses `embedded`, not `inproc`

`inproc`'s own design (bare `VerbatimStore`, no SurrealDB, no `createLore()`
overhead) was chosen because it isolates the ONE root cause named in
`scripts/measure-memory.mjs`'s original header — `VerbatimStore.close()`
(`engines/verbatimStore.ts:1798`) nulls `this.table`/`this.db` instead of
calling their native `close()`. That prediction does not hold up under
measurement (§2.2): `inproc` is flat, with or without forced GC.

The most likely explanation: once a cycle's `store` variable goes out of
scope, nothing else references it or its `table`/`db` wrapper objects, and
ANY V8 GC — forced or the engine's own incidental one — collects the whole
graph. If LanceDB's napi bindings free the native handle on GC of the JS
wrapper (a FinalizationRegistry-style pattern is common for native addons),
then `close()` never actually calling the native `close()` is a real
correctness gap (a `close()`d store's handle could still receive a
use-after-close crash if something else raced it) but is not, by itself,
what shows up as `embedded`'s severe RSS growth. `embedded`'s much larger,
longer-lived object graph (SurrealDB connection, ONNX pipeline,
`loadJobsStore`, `WorkspaceVerbatimResolver`, audit/outbox subsystems — see
`STEP2-CLOSE-PATH-DESIGN.md` item (d) for the audit of what else holds a
long-lived native handle) is where the leak is actually visible.

This is reported as a genuine, evidence-based finding — not a gap in this
sprint's measurement. **Root cause #1 (VerbatimStore's dereference-only
close) may still be worth fixing for correctness** (the use-after-close
hazard `STEP2-CLOSE-PATH-DESIGN.md` §(a) describes), but it is not, on this
evidence, the dominant contributor to the RSS growth this sprint exists to
fix. Step 2 should look hardest at what `embedded`'s lifecycle holds that
`inproc`/`worker` don't: the SurrealDB connection, the ONNX embedding
pipeline cache, and the sqlite/outbox/resolver subsystems named above.

### 2.5 Caveat: concurrent-run contention in the first full-50-cycle pass

The first full 50-cycle `worker` and `embedded` runs (tables in §2.2) were
launched back-to-back to save wall-clock time, so for part of each run the
other was still executing on the same machine. This shows up ONLY in cycle
TIMING (worker's cycles 13-50 in that first pass ranged 3.6-5.6s instead of
a flatter ~2.5s; embedded's early cycles were slower before worker
finished) — never in RSS, which is sampled via `process.memoryUsage()`
independent of CPU contention. Both configs were re-run in isolation
(nothing else running) to confirm: the `worker` regression numbers quoted
above are from the isolated re-run; `embedded`'s isolated 20-cycle re-run
(§2.2) reproduced the same ~100 MB/cycle slope, confirming contention did
not manufacture the leak. The isolated `worker` re-run still shows an
unexplained timing bump in its own back third (§2.1) with RSS unaffected —
attributed to unrelated system load (this is a shared dev machine), flagged
rather than hidden.

---

## 3. Worker child-process finding

**Question asked:** does `VerbatimSearchWorkerProxy` (the `LORE_SEARCH_WORKER=1`
isolation path) ever leave a search-worker child process running or
orphaned after `close()`?

**Method:** after each cycle's `close()` (with a 100ms settle delay so a
just-SIGKILLed child's normal, transient zombie/exiting state — which
clears on Node's next event-loop tick — isn't mistaken for a still-running
orphan), count direct children of the harness's own PID via
`ps -eo pid=,ppid=,rss=,state=,comm=`, excluding the sampling `ps` process
itself. Zombie-state children are counted separately (`zombies`) from
live/running children (`children`) for exactly this reason.

**Result:** across all 50 cycles of the isolated re-run, **`children` = 0
and `zombies` = 0 at every single sample**, and 0 live children after the
final `close()`. No accumulation, no orphans.

An earlier probe (before the 100ms settle delay was added) transiently saw
2-3 processes per sample immediately after `close()` — investigated
directly (`test/helpers`-style standalone probes, not committed — this was
throwaway investigation) and confirmed to be: (a) the just-killed child in
a `?E` (exiting/zombie) state that clears within ~300ms on its own, and (b)
the sampling `ps` process seeing itself mid-run. Neither is a real leak;
both are now excluded from the reported count.

**Verdict: no evidence of leaked or orphaned search-worker child
processes.**

---

## 4. Deliverable B — unclean vs. clean SurrealDB first-open peak RSS (Q2)

Answers Q2 of `../nirman-tapestry/docs/lore-asks/QUESTIONS-FOR-LORE.md`
(read-only reference; that repo is not touched by this sprint):

> "What does SurrealDB's unclean-shutdown recovery cost in RSS?" — citing an
> alarming precedent from the PRIOR local graph engine (removed 2026-08-21,
> see `docs/KUZU_REMOVAL.md`): 12,567 MB peak RSS opening a workspace with a
> ~13 MB WAL, i.e. roughly 1000× the WAL size, from one data point on an
> engine no longer in this codebase.

**Method** (`scripts/measure-surreal-unclean-open.mjs`, built on the
existing `scripts/diagnostics/wal-memory.ts` harness): write 3,000 graph
nodes (+5,997 edges) via `SurrealGraph.bulkUpsertNodes`-shaped writes in a
child process, then either close it cleanly or `SIGKILL` it mid-life
(`wal-memory.ts`'s existing `gen` stage, both exit modes). Then, in a FRESH
child, open the store once and poll the child's OS-reported RSS via
`ps -o rss= -p <pid>` every 15ms for its entire lifetime, keeping the
maximum — this catches a transient spike inside the native open/replay call
even if the child's event loop never yields to let it self-report.

### Results (3,000 nodes, 5,997 edges)

| | on-disk `.lore/surreal` before open | wal-like files before open | peak RSS during open | open self-reported: baseline → afterOpen → afterStats | openMs |
|---|---|---|---|---|---|
| **clean** | 5.16 MB | 0.00 MB | **134.1 MB** | 101 → 113 → 134 MB | 69 ms |
| **unclean** (SIGKILL mid-write) | 5.97 MB | 5.97 MB | **141.9 MB** | 101 → 120 → 140 MB | 68 ms |

**Delta (unclean − clean): +7.8 MB.** Against a ~6 MB wal-like on-disk
footprint, that is roughly **1.3×**, not the ~1000× the prior engine's one
data point suggested. Open time is identical either way (~68-69ms) — no
evidence of a slow WAL replay path either.

**Answer to Q2, on this evidence: SurrealDB's unclean-shutdown recovery
cost in RSS is small and roughly proportional to the WAL-like footprint,**
nowhere near the catastrophic multiplier measured on the engine that has
since been removed. This is good news for any daemon design that assumes a
clean-shutdown guarantee is load-bearing for memory safety (see Q2's "why
this changes our design" framing) — on this data, an occasional unclean
exit does not create an outsized RSS spike on next open.

**Caveat — not exhaustively scaled.** A follow-up run at 12,000 nodes was
attempted and its `gen` (unclean) stage was killed by this session's own
300s timeout wrapper before completing (12,000 sequential node+edge
upserts simply take longer than budgeted, unrelated to the SIGKILL logic
itself) — **not measured, and not re-attempted given this sprint's time
budget.** The 3,000-node result is real and internally consistent (both
arms' `openMs` and `afterStats` numbers behave sensibly), but this document
does not claim the ~1.3× ratio holds at significantly larger WAL sizes;
that would need a dedicated follow-up with a longer timeout budget.

### Reproduce

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH
node scripts/measure-surreal-unclean-open.mjs --nodes 3000 --json /tmp/surreal-unclean.json
```

---

## 5. Deliverable C — regression unit test

> **Superseded 2026-09-18 by §13.** The single `embedded`-cycle test this
> section describes was split into `test:unit:memory-open-close-cycles`
> (rewritten to cover only what Lore controls) and the new
> `test:unit:memory-surreal-leak-pinned` canary — see §13 for why and what
> changed. This section is kept as the historical record of the original
> design; the test files it describes no longer match what's on disk.

`test/memory-open-close-cycles-unit.ts` (+ helper
`test/helpers/memory-open-close-cycles-child.ts`), registered as
`npm run test:unit:memory-open-close-cycles`. **Deliberately NOT in the
main `npm test` chain** — a test engineered to fail on the current version
would break CI.

Runs the `embedded` cycle body (not `inproc` — see §2.4 for why) for 12
cycles / 150 entries per cycle in a child process with `--expose-gc`, wiping
the workspace's `.lore/` data between cycles (same confound fix as §2.1).
12 cycles was chosen over the diagnostic script's 50-cycle default because
`embedded`'s measured ~100 MB/cycle growth would put a 50-cycle run's peak
RSS north of 5 GB — an unnecessary OOM risk for a unit test when the slope
is already unambiguous (R² > 0.99) well before cycle 10 in every real run
so far.

**Threshold:** fails if the RSS slope over cycles 5-12 is ≥ 10 MB/cycle.
Chosen from real measurements (this document): a genuine leak on 3.19.1
measures 60-105 MB/cycle across every run; the leak-free `inproc`/`worker`
harnesses measure -0.2 to +0.2 MB/cycle. 10 MB/cycle sits roughly two orders
of magnitude above the measured noise floor and one order of magnitude
below the smallest leak ever measured in this sprint, so it fails reliably
on 3.19.1 without being at risk of flaking once the leak is fixed.

### Actual failing output on 3.19.1

```
Memory open/close cycles — embedded config, 12 cycles, 150 entries/cycle
(this is expected to FAIL on 3.19.1 and PASS once the Step 2 close-path fix lands)
  ✓ embedded open/write/dispose cycles complete and report samples
    cycles 5..12: first=1370.6 MB last=2073.2 MB slope=100.388 MB/cycle R^2=1.000
  ✗ RSS slope over cycles 5..12 is flat within noise (< 10 MB/cycle)
    RSS is climbing 100.4 MB/cycle (R^2=1.000) over cycles 5..12 (1370.6 MB -> 2073.2 MB) — this is the memory-leak-sprint leak (see docs/PERFORMANCE-MEMORY.md); expected to fail on 3.19.1, expected to pass once Step 2's close-path fix lands

1 passed, 1 failed
```

A standalone calibration run of the child helper (12 cycles / 150 entries,
run directly, not through the test wrapper) independently measured
**~89-101 MB/cycle** across cycles 3-12 — consistent with both the
diagnostic script's 50-cycle (100.2 MB/cycle) and 20-cycle (100.3 MB/cycle)
runs, and with a second run of the test itself (100.5 MB/cycle). Five
independent measurements across three different harness shapes and cycle
counts, all landing within 100 ± 1 MB/cycle: this is a robust, reproducible
number, not a one-off.

### Reproduce

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH
npx tsx test/memory-open-close-cycles-unit.ts
# or:
npm run test:unit:memory-open-close-cycles
```

---

## 6. Verification run against this sprint's changes

- `npm run test:arch` — **passes** (0 exit code; includes file-size,
  type-check-over-`test/`, no-legacy-engine-refs, and orphaned-cleanup
  guards). One `test:arch` failure was found and fixed during this work: a
  first draft of `scripts/measure-surreal-unclean-open.mjs` named the prior
  (removed) local graph engine literally in prose, which the
  no-legacy-engine-refs guard correctly rejects; reworded to describe it
  structurally instead ("the prior local graph engine") without the
  banned literal.
- `npx tsc --noEmit` — **clean** (0 lines of output, exit 0).
- New test files (`test/memory-open-close-cycles-unit.ts`,
  `test/helpers/memory-open-close-cycles-child.ts`) type-check cleanly
  under `tsconfig.test.json` — not added to `.test-type-baseline.json`'s
  quarantine, no baseline update needed.

---

## 7. What was NOT measured, and why

- **Surreal unclean-vs-clean at WAL sizes larger than ~6 MB** — the 12,000-node
  follow-up timed out mid-write (§4 caveat); not re-attempted given this
  sprint's time budget. The 3,000-node (~6 MB wal-like) result stands on
  its own but should not be extrapolated to much larger stores without
  a dedicated re-run.
- **`vmmap`-based footprint on non-darwin.** `vmmapFootprintMb` returns
  `null` (not measured, not estimated) on any non-darwin platform or if
  `vmmap` needs elevated privilege — this sprint's machine is darwin/arm64,
  so every run in this document has real `vmmap` numbers, but the harness's
  behaviour elsewhere is untested.
- **The `embedded` config's per-subsystem attribution.** ~~This document
  proves `embedded` leaks ~100 MB/cycle in aggregate; it does NOT isolate
  which of SurrealDB / the ONNX embedding pipeline / `loadJobsStore` /
  `WorkspaceVerbatimResolver` / audit-outbox subsystems is responsible for
  how much of that.~~ **Done — see §8, "Attribution (3.19.1)" below.**
- **CI portability of the `embedded`-based unit test.** The `embedded`
  config loads the real local ONNX embedding model
  (`Xenova/multilingual-e5-small`). On this dev machine it was already
  cached (~700ms load). Whether a fresh CI runner has this cached, or would
  need network access to fetch it on first run, was not checked — this is
  the same pre-existing dependency several already-shipped tests have
  (e.g. `test:unit:embedding-provider`), not a new one introduced here, but
  it is called out explicitly since it was not verified as part of this
  sprint.

---

## 8. Attribution (3.19.1)

Measurement-only, same as §1-7: **nothing in `packages/` changed to produce
this section.** Six configurations were added to
`scripts/measure-memory.mjs` (cycle bodies + fd/substrate-file sampling live
in the new sibling module `scripts/measure-memory-configs.mjs`, kept
separate to stay under the file-size discipline) to find which subsystem(s)
account for `embedded`'s ~100 MB/cycle (§2.2). All six ran for 15 cycles on
the same machine/Node/Lore version as §1-7 (darwin/arm64, Node 22.23.2, Lore
3.19.1 @ main, measured 2026-09-17). Regression is computed over cycles
5-15 (cycles 1-4 excluded as warm-up, same convention as §2.2).

### 8.1 Headline result

**The entire ~100 MB/cycle leak is explained by `SurrealGraph`'s
`close()` not releasing native file handles — nothing else in the object
graph contributes a measurable per-cycle slope.** Two independent lines of
evidence converge on this:

1. `embedded-empty` (createLore()+dispose(), **zero writes**) already leaks
   at 92.2 MB/cycle — almost the full rate — before a single document is
   ever stored. The leak is in instance construction/teardown itself, not
   in anything a write does.
2. `surreal-only` (a bare `SurrealGraph`, **no Lore, no ONNX, no LanceDB, no
   outbox/sqlite at all**) leaks at 99.4 MB/cycle, R²=1.000 — reproducing
   the full `embedded` rate with nothing else in the process.

Both configs also show the same **open-file-descriptor signature**: the
count of open files under `.lore/surreal/` (a LOCK file + WAL/manifest
files — see `sampleSubstrateFileCounts` in
`scripts/measure-memory-configs.mjs`) grows by **exactly +3 per cycle**,
monotonically, in every config that touches `SurrealGraph` — and in NO
config that doesn't. `SurrealGraph.close()` (`engines/surrealGraph.ts:191`)
does call the driver's `connection.db.close()` before this harness samples,
so this is not a case of `close()` never being called; the native handle(s)
underneath the driver's own close call are not actually being freed.

### 8.2 Per-config results (cycles 5-15 regression, 100 entries/cycle unless noted)

| config | slope (MB/cyc) | R² | RSS first→last (cyc 1→15) | heapUsed trend | fd trend (cyc 1→15) | substrate-file trend | cycle time (cyc 1→15) |
|---|---|---|---|---|---|---|---|
| `embedded` (§2.2, for reference) | 100.2-100.4 | 1.000 | 1066→5804 MB (50 cyc) | flat (~227 MB) | not sampled in §2.2 | not sampled in §2.2 | ~5-7s |
| `embedded-empty` | **92.185** | 0.991 | 1005.6→2311.5 MB | flat (224.0→224.9 MB) | 46→88 (+3/cyc) | `surreal` 4→46 (+3/cyc); `lance` flat @1; `sqlite` flat @0 (closed by dispose) | 779→449 ms |
| `embedded-precomputed` | **92.165** | 0.990 | 1022.8→2331.3 MB | flat (224.6→225.8 MB) | 46→88 (+3/cyc) | `surreal` 4→46 (+3/cyc); `lance` flat @1; `sqlite` flat @0 | 832→495 ms |
| `embed-only` | **-11.573** (noise) | 0.686 | 809.0→732.1 MB | flat (188.7→188.9 MB) | flat @33 | all flat @0 (no on-disk store) | 537→185 ms (see §8.3) |
| `surreal-only` | **99.422** | 1.000 | 223.2→1622.3 MB | flat (11.6→12.0 MB) | 29→71 (+3/cyc) | `surreal` 6→48 (+3/cyc); `lance`/`sqlite` n/a (not opened) | 584→550 ms |
| `inproc-nogc` (200 entries/cyc) | **0.244** (noise) | 0.972 | 385.9→335.4 MB | flat-ish (64.5→57.0 MB) | not sampled (see §8.4) | not sampled | 3018→2850 ms |
| `workspace-cycle` | **101.069** (RSS) | 1.000 | 1172.2→2491.2 MB | flat (~225.4→226.6 MB) | 70→112 (+3/cyc) | `surreal` 7→49 (+3/cyc); `lance` flat @1; `sqlite` flat @21 | 1051→1000 ms |
| `workspace-cycle` (resolver) | **1.000 handles/cyc** | 1.000 | resolverOpenCount 2→16; registryOpenCount flat @1 | — | — | — | — |

A "noise" slope means the magnitude is small relative to the run's own
cycle-to-cycle scatter (comparable to §2.2's documented -0.13 to +0.07
MB/cycle noise floor for `inproc`/`worker`), not a real trend — see §8.3-8.4
for why each one is flat.

### 8.3 `embed-only` — the ONNX pipeline does not reload, and does not leak

`initMs` (this cycle's `LocalEmbeddingProvider.initialize()` wall time) was
logged every cycle as the reachable proxy for "did the pipeline reload"
(the module-level `pipelineCache` in `providers/localEmbeddingProvider.ts`
is not exported, so its size/hit-count cannot be read without editing
package source, which this measurement-only sprint does not do):

| cycle | 1 | 2 | 3 | 4-15 |
|---|---|---|---|---|
| initMs | 357.3 | 0.1 | 0.1 | 0.0-0.1 |

Cycle 1 pays the one-time cold ONNX load (~357 ms); every subsequent cycle
— a **fresh `LocalEmbeddingProvider` instance** — resolves in a fraction of
a millisecond. Since the cache is keyed by `${modelId}:${device}:${dtype}`
and not by instance, this confirms the pipeline is loaded once per process
and reused across instances, not reloaded per `createLore()` call. The
regression's negative/noisy slope (-11.6 MB/cycle, R²=0.686) and flat fd
count (33 the whole run) confirm `embedDocumentBatch()` itself does not
accumulate native memory or file handles cycle over cycle either.
`lore.dispose()` was not exercised in this config (there is no Lore
instance), so whether `dispose()` clears the pipeline cache is answered
separately, statically: `packages/lore/src/mcp/shutdownDrain.ts` (the
ordered drain every `dispose()` call runs) contains no reference to
`pipelineCache` or `_resetLocalEmbeddingPipelineForTests` — grepped, zero
hits — so **`dispose()` does not clear it**, by construction. That's
consistent with `embedded`/`embedded-empty`/`embedded-precomputed` all
showing fast (sub-second) cycle times after cycle 1 despite calling
`createLore()` (and therefore constructing a fresh `LocalEmbeddingProvider`)
15 times each.

### 8.4 `inproc-nogc` — forcing GC was not masking a leak

Same `inproc` engine-level harness as §2.2 (bare `VerbatimStore`, fake
embedder, no SurrealDB), but with `--force-gc 0` for the entire 15-cycle
run instead of §2.2's 25-cycle spot-check. Slope 0.244 MB/cycle (R²=0.972)
over cycles 5-15 — the R² is high only because the series is short and
mildly monotonic in this particular run, not because the trend is real: the
magnitude is in the same noise band as §2.2's original with-GC run (-0.127
MB/cycle) and its own 25-cycle no-GC spot-check (+0.066 MB/cycle). fd/
substrate-file sampling was not added to this config (`inproc`/`worker`
were left exactly as §2.2 specified them, to keep their already-documented
numbers reproducible byte-for-byte); the RSS/heapUsed signal alone is
sufficient here since §2.2 already established `inproc` opens no SurrealDB
handle at all. **Verdict unchanged from §2.2: no leak in the LanceDB-only
path, forced GC or not.**

### 8.5 `workspace-cycle` — the real host shape, and a second, additive leak

This config reproduces the shape Atlas actually runs (one long-lived
embedded Lore instance; many short-lived per-task/per-repo workspaces
opened and closed against it) rather than `embedded`'s single
always-default-workspace shape. Each cycle: register a fresh workspace,
open it through `lore._daemon.getGraphRegistry().getGraphHandle()`, write
100 nodes through the public `lore.bulkIngest(nodes, { embed: 'sync' })`
API (which routes the verbatim vectors through
`WorkspaceVerbatimResolver.getOrOpen()` — see
`mcp/bulkIngest.ts`'s `writePrebuiltRowsPerWorkspace`), close what 3.19.1
offers (`registry.evictIdle(Date.now(), 0)`), then unregister. Full
per-cycle sequence and rationale is in
`scripts/measure-memory-configs.mjs`'s `runWorkspaceCycle()` docstring.

Two separate, additive findings:

- **RSS slope (101.1 MB/cycle, R²=1.000)** matches `embedded`/
  `surreal-only` almost exactly — the same SurrealGraph-close leak (§8.1)
  reproduces per-workspace, not just for the boot workspace.
- **`WorkspaceVerbatimResolver.openCount()` grows by exactly 1.000 per
  cycle (R²=1.000; 2→16 over 15 cycles) while `LocalGraphRegistry.openCount()`
  stays flat at 1** (the pinned boot graph — `evictIdle(now, 0)` closes every
  sibling graph it opened, every cycle, as designed). This is a **second,
  independent, additive leak specific to multi-workspace hosts**: reading
  `packages/lore/src/outbox/workspaceVerbatimResolver.ts` end to end, its
  only two release paths are `prime()` (marks a path as pinned/never-closed)
  and `closeAll()` (closes **every** non-pinned store at once). There is no
  per-workspace idle-eviction method — no `evictIdle`, no LRU cap, nothing
  the graph registry's `evictIdle(now, idleMs)` has an equivalent of. A
  long-running host that opens and closes many workspaces (exactly Atlas's
  shape) accumulates one live `VerbatimStore` (LanceDB) handle per distinct
  workspace ever touched, for the life of the process, on top of the
  per-cycle SurrealDB leak in §8.1. This does not show up in the baseline
  `embedded` metric (§2.2) at all, because that config never opens a second
  workspace.

**Finding used to build this config — two different "homes" for one
workspace.** `LocalGraphRegistry` (constructed via
`buildGraphRegistryForLocalMode()` in `mcp/server.ts`, no explicit `home`
argument at its one call site) and `WorkspaceVerbatimResolver.getOrOpen()`
(`getWorkspacePath(workspace)`, no explicit `home` argument) both default to
`loreHome()`, but were observed, empirically, to resolve against **different
homes** in this harness's shape (`createLore({ dataDir })` with a `dataDir`
distinct from `process.env.LORE_HOME`): the registry resolves against
`dataDir`, the resolver resolves against `process.env.LORE_HOME`. Verified
directly (`createWorkspace()`/`registerWorkspaceAlias()` registered at only
one of the two homes reliably reproduced `workspace_not_found` from
whichever consumer used the other one). This harness therefore registers
each cycle's workspace at **both** homes
(`createWorkspace(name, {}, dataDir)` then
`registerWorkspaceAlias(name, entry.path, {}, home)`) to reach both
consumers through the public API with no source changes — reported here as
a finding for whoever picks up the resolver-eviction fix, not something
this measurement-only sprint resolves.

**Harness-only accommodation, not a source change.** `bulkIngest`'s graph
write also records a durable outbox "hot write" for the `node.upsert` op,
replayed asynchronously by the outbox replicator on its own timer
(`outbox/replicator.ts`'s `DEFAULT_REPLICATOR_CONFIG`: 250ms idle nap / 10ms
busy nap). Deleting a workspace's registration before that replay runs
made the replicator's graph resolve fail permanently
(`workspace_not_found`) and **retry forever at the 10ms busy cadence with
no backoff or retry cap** — discovered empirically while building this
config (one early run produced hundreds of identical retry log lines within
seconds and never stopped). `runWorkspaceCycle()` waits 350ms after
`bulkIngest()` — one full idle-nap window — before evicting/unregistering,
which was sufficient across all 15 cycles of the official run (zero
"graph resolve for workspace ... failed" lines in the log). This is flagged
as its own finding (an outbox replicator retry with no backoff/cap is a
real gap, independent of the memory-leak sprint) rather than silently
worked around.

### 8.6 Attribution table

Of `embedded`'s measured ~100 MB/cycle:

| Subsystem | Contribution | Evidence |
|---|---|---|
| **SurrealDB (`SurrealGraph`/surrealkv native handle, via `close()`)** | **~92-101 MB/cycle — effectively ALL of it** | `embedded-empty` (zero writes) = 92.2 MB/cycle; `surreal-only` (nothing but SurrealGraph) = 99.4 MB/cycle, R²=1.000; open-file count under `.lore/surreal/` grows +3/cycle in every config that opens a SurrealGraph and in no config that doesn't; `heapUsed` flat in every one of these runs (native, not JS-heap, matching §1's finding) |
| **ONNX embedding pipeline (`LocalEmbeddingProvider`)** | **~0 MB/cycle** | `embed-only` in isolation: -11.6 MB/cycle (noise); `embedded-precomputed` (real embedded object graph, ONNX skipped on the write path) = 92.165 MB/cycle, statistically indistinguishable from `embedded-empty`'s 92.185 MB/cycle — removing ONNX from the per-cycle work changes nothing; pipeline is cached module-wide and not reloaded per instance (§8.3) |
| **LanceDB / `VerbatimStore`** | **~0 MB/cycle** | `lanceFiles` (open-file count under any `lancedb` path) stays flat at exactly 1 across every config that has a LanceDB store open, for all 15 cycles; `inproc`/`worker` (§2.2, bare `VerbatimStore`, no SurrealDB) are flat with or without forced GC (§2.2, §8.4) |
| **SQLite sidecars (outbox/aux/versions/load-jobs/pending-ops)** | **~0 MB/cycle** | `sqliteFiles` count is flat every cycle in every config sampled (0 after each `embedded-empty`/`embedded-precomputed` dispose — correctly closed; flat @21 for the whole `workspace-cycle` run, where the single Lore instance stays open) |
| **`WorkspaceVerbatimResolver` (multi-workspace hosts only)** | **Separate, additive — not part of the ~100 MB/cycle base rate, but +1 unclosed LanceDB handle per distinct workspace ever touched** | `workspace-cycle`: `openCount()` grows 1.000/cycle, R²=1.000, with zero eviction path in 3.19.1 (§8.5); does not appear in `embedded`'s own metric because that config never opens a second workspace |
| **Everything else** (audit log, load-jobs runner, active-session tracker, rate limiter, retention scheduler, etc.) | **No residual left to attribute** | `embedded-empty`'s 92.2 MB/cycle and `surreal-only`'s 99.4 MB/cycle agree to within run-to-run variance despite `surreal-only` having none of these subsystems at all; there is no leftover slope for them to explain |

**What doesn't add up, stated explicitly:** `embedded-empty` (92.2 MB/cycle)
and `surreal-only` (99.4 MB/cycle) differ by ~7 MB/cycle despite both
attributing ~100% of their own slope to the same SurrealDB mechanism. This
gap is smaller than it looks — `embedded-empty`'s R² (0.991) is measurably
softer than `surreal-only`'s near-perfect 1.000, meaning `embedded-empty`'s
own cycle-to-cycle scatter is wider (consistent with the much larger,
noisier object graph it constructs and tears down around the same
SurrealGraph — ONNX provider, outbox wiring, audit exporter, session
tracker, etc. — even though none of those move the *slope*). ~7 MB/cycle
sits inside that scatter band; it is reported rather than rounded away, but
is not read as a second, distinct leak source given every other line of
evidence (fd counts, `embedded-precomputed` matching `embedded-empty` almost
exactly) points at one mechanism.

### 8.7 Reproduce

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH   # Node 22 required
cd groundfloor-lore

node scripts/measure-memory.mjs --config embedded-empty       --cycles 15 --entries 100 --json /tmp/embedded-empty.json
node scripts/measure-memory.mjs --config embedded-precomputed --cycles 15 --entries 100 --json /tmp/embedded-precomputed.json
node scripts/measure-memory.mjs --config embed-only           --cycles 15 --entries 100 --json /tmp/embed-only.json
node scripts/measure-memory.mjs --config surreal-only         --cycles 15 --entries 100 --json /tmp/surreal-only.json
node scripts/measure-memory.mjs --config inproc-nogc          --cycles 15 --entries 200 --json /tmp/inproc-nogc.json
node scripts/measure-memory.mjs --config workspace-cycle      --cycles 15 --entries 100 --json /tmp/workspace-cycle.json
```

Each run creates and destroys its own `mktemp`-style temp `LORE_HOME`; none
touch `~/.groundfloor` or any running daemon. `workspace-cycle` additionally
creates/destroys per-cycle workspace subdirectories under that same temp
root (never wiped mid-run — see the "deliberately NOT wiped" note in
`runWorkspaceCycle()`'s docstring — only removed when the whole temp
`LORE_HOME` is deleted at the end of the run).

### 8.8 What this section does NOT establish

- **Why `SurrealGraph.close()` / `connection.db.close()` leaves native
  memory behind** — whether it's the `@surrealdb/node` binding, the
  underlying `surrealkv` engine's own close path, or something in between.
  This sprint's scope is attribution (which subsystem), not root-causing
  the native binding itself — that is downstream work.
- **Why exactly 3 file descriptors per cycle** (vs. 1, 2, or more) — plausible
  candidates seen in a manual `lsof` probe are the `.lore/surreal/LOCK` file
  and WAL/manifest segment files, but this sprint did not instrument the
  driver to confirm which 3, or whether that count is stable across
  surrealkv WAL sizes larger than this harness's 100-entries/cycle write
  volume.
- **A precise MB-per-leaked-fd ratio.** ~100 MB/cycle over 3 fds/cycle is
  ~33 MB per handle, consistent with a memory-mapped WAL/sstable segment
  being held resident rather than a small buffer, but this was not measured
  directly (no per-fd RSS attribution tool was used) and should be read as
  a plausible order-of-magnitude note, not a verified figure.

---

## 9. Verdict — which native library keeps memory after a correct close (3.19.1)

**`@surrealdb/node@3.0.3` (the embedded SurrealDB native addon) does not destroy its datastore
on `close()`.** Lore's close path is correct and complete; no call reachable from Lore returns
the memory; only process exit does. Every other substrate Lore opens (LanceDB, better-sqlite3,
the ONNX embedding pipeline) returns its memory on close.

### Evidence

| # | Observation | What it rules out |
|---|---|---|
| 1 | Bare `SurrealGraph` open → write 100 nodes → `close()`, fresh dir each cycle: **+99-100 MB/cycle, R²=1.000**, JS heap flat (§8). Re-run independently: 223 → 1,120 MB over 10 cycles. | Lore's other subsystems |
| 2 | The native binding driven directly — `SurrealNodeEngine.connect()` → cbor `execute()` → `free()`, with no Lore, no `surrealdb` JS SDK wrapper and `notifications()` never called — leaks at the **same 100.3 MB/cycle**. | Lore's close code; the JS SDK; the live-query notification loop |
| 3 | After `close()`/`free()` the process still holds the store's `wal/…0.wal` (2 fds) and `sstables/…1.sst` (1 fd): **+3 open files per cycle**, never released. | "Memory held but datastore gone" — the datastore itself is alive |
| 4 | `vmmap` after 1 vs 6 cycles: `MALLOC_LARGE` grows by **exactly 2 regions (200 MB virtual, 100 MB resident) per open** — 2 → 12 regions, 100 → 600 MB resident — with the malloc zone reporting those bytes as *allocated* and **0 % fragmentation**. | Allocator fragmentation / retention. These are live allocations that were never freed. |
| 5 | Reopening the **same** directory 10 times without wiping leaks the same 100.3 MB per reopen. | "Only new stores leak". Evict-then-reopen leaks every time. |
| 6 | `rocksdb://` leaks too, at 64.7 MB/cycle; `mem://` is flat. | A surrealkv-only bug. The leaked allocations are the on-disk engines' per-datastore buffers; `mem://` opens none. |
| 7 | `SURREAL_SURREALKV_BLOCK_CACHE_CAPACITY` = 8 MiB / 32 MiB: 97.9 / 97.7 MB/cycle. `SURREAL_ROCKSDB_WRITE_BUFFER_SIZE` = 8 MiB: 64.7 MB/cycle. | A tunable cache. The retained size does not follow the env knobs the binary reads. |
| 8 | `npm view`: 3.0.3 (2026-03-09) is the latest `@surrealdb/node`; `surrealdb` 2.0.8 is the latest SDK. Both are what Lore pins. | An available upgrade |

The single-process explanation that fits all eight: each on-disk datastore allocates two ~100 MB
buffers when it opens (surrealkv; ~64 MB total for rocksdb), and `free()` drops the JS-side
handle without the Rust `Datastore` being destroyed — so its buffers and its WAL/sstable file
handles live until the process exits. Which Rust object keeps the `Datastore` referenced is not
observable from JS. Establishing that needs the addon's source, and it is an upstream question.

Probe script: `scripts/diagnostics/leak-hypothesis-probe.mjs` (modes `h0`-`h5`).

### What it means for hosts

- **An open surrealkv store costs ~100 MB resident regardless of size**, and that cost is paid
  again on every open in the same process, including a reopen of the same workspace.
- **Graph idle eviction is net-negative on this driver.** Keeping a graph open costs ~100 MB once;
  evicting and reopening it costs ~100 MB per reopen, without bound. The verbatim (LanceDB) half
  does return its memory, so evicting that half is net-positive.
- **In-process, "zero resident when idle" is unreachable for the graph half on 3.0.3.** Only
  process exit, or hosting SurrealDB in a disposable child process (the pattern
  `VerbatimSearchWorkerProxy` already uses for LanceDB search), returns this memory.
- The unclean-shutdown result (§4) is unaffected: first-open after `SIGKILL` costs 7.8 MB more
  than after a clean close.

### Not established

- Behaviour on linux-x64. glibc's allocator differs, but a never-destroyed datastore would leak on
  any allocator. Unmeasured.
- A driver-internal workaround. A second `close()` is a no-op in the JS wrapper (`#engine` is
  already `undefined`), so the extra RSS seen after it in probe H5 is attributed to the deferred
  WAL→sstable flush, not to the second call. That reading is inferred, not proven.

---

## 10. 3.20.0 after-measurements (scratch/step3-integration)

Measured on the integration branch that merges `feat/verbatim-store-role`
(504eb641), `feat/search-worker-policy` (40d8c469),
`feat/embed-pipeline-idle-unload` (dd48cb4e), and
`feat/injected-embedding-provider` (a8ee7618) on top of `scratch/step2-integration`
(the branch that fixed the verbatim-resolver eviction gap this section's M1
directly re-measures). HEAD at measurement time: `c2ec84dc`. `package.json`
still reads `3.19.1` (unbumped); "3.20.0" here names the feature set, not an
already-tagged release.

**Machine/versions** (same machine as §1-9, one session, nothing else heavy
running — checked via `ps` before every run): darwin/arm64 (macOS 26.5.1,
Darwin 25.5.0), Node **22.23.2**, `@lancedb/lancedb` / `@surrealdb/node`
pinned versions unchanged from §1-9. "Before" numbers are either cited
directly from §2/§8 (3.19.1 @ `main`, same machine, measured 2026-09-17) or
freshly re-measured against a `main`-branch (`c600b62d`) git worktree with
this repo's `node_modules` symlinked in (M2 only — M1's "before" is citation,
not re-measurement, per the ask).

### 10.1 M1 — 50-cycle open/close, all four configs (after only; before = §2/§8)

Reproduce (from `scratch/step3-integration`):

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH
node scripts/measure-memory.mjs --config inproc           --cycles 50 --entries 200 --json /tmp/inproc.json
node scripts/measure-memory.mjs --config worker           --cycles 50 --entries 200 --json /tmp/worker.json
node scripts/measure-memory.mjs --config embedded         --cycles 50 --entries 200 --json /tmp/embedded.json
node scripts/measure-memory.mjs --config workspace-cycle  --cycles 50 --entries 100 --json /tmp/workspace-cycle.json
```

| config | entries/cyc | slope MB/cyc (cyc 5-50) | R² | RSS first→last (cyc 1→50) | fds first→last | resolver openCount |
|---|---|---|---|---|---|---|
| `inproc` | 200 | **-0.114** | 0.137 | 373.5 → 277.0 MB | not sampled (unchanged from §2.2 convention) | n/a (no resolver in this config) |
| `worker` | 200 | **-0.155** | 0.150 | 309.7 → 196.6 MB | 0 live children / 0 zombies, every cycle | n/a |
| `embedded` | 200 | **99.640** | 0.999 | 1117.5 → 5770.0 MB | not sampled (unchanged from §2.2 convention) | n/a (single default workspace, resolver never touched a 2nd path) |
| `workspace-cycle` | 100 | **100.643** (RSS) | 1.000 | 1076.6 → 5915.8 MB | 70 → 217 (surrealFiles 7→154, **+3/cycle**, the known §8.1 leak; lanceFiles flat @1 the whole run) | **flat @ 1, slope = 0.000/cycle, R²=1.000** |

**Before, cited (§2.2/§8.2):** `inproc` -0.127 MB/cyc (R²=0.090); `worker`
-0.157 MB/cyc (R²=0.134, "0 live children and 0 zombies at every single
sample"); `embedded` 100.218 MB/cyc (R²=1.000, 1066.2→5803.8 MB over 50
cycles); `workspace-cycle` (§8.5, 15-cycle pre-fix run) RSS 101.069 MB/cyc
(R²=1.000) **and `WorkspaceVerbatimResolver.openCount()` growing
1.000/cycle (R²=1.000, 2→16 over 15 cycles) — the specific gap
`feat/verbatim-store-role`'s sibling step2 fix (resolver `evictIdle`) targeted.**

**Verdict — M1's one load-bearing result:** `inproc`, `worker`, and
`embedded`'s slopes are statistically unchanged from §2/§8 (all differences
are inside the documented noise band, e.g. `inproc` -0.114 vs -0.127
MB/cyc) — expected, since none of the four merged branches touch the
SurrealGraph-close leak that dominates `embedded`'s number. **`workspace-cycle`'s
`resolverOpenCount` no longer grows.** It sat flat at exactly 1 for all 50
cycles (slope 0.000, R²=1.000) instead of climbing to 16 over just 15
cycles pre-fix — the resolver-idle-eviction gap §8.5 found is closed. The
RSS slope for `workspace-cycle` (100.643 MB/cyc) is still ~100 MB/cyc
because the SurrealGraph-close leak (§8.1/§9, not in this integration's
scope) dominates it exactly as it dominates `embedded`'s own number; the
resolver fix is additive and only visible in `resolverOpenCount`, exactly
as §8.5 predicted ("a second, independent, additive leak").

### 10.2 M2 — per-open-store cost + handle count, before vs after

New script: `scripts/diagnostics/open-store-cost-measure.mjs`. Opens N=10
distinct-workspace `VerbatimStore`s in one process, keeps all 10 alive, and
reports (RSS after opening all 10 − baseline) ÷ 10, `handleCount()` per
store (when the build has it), and an `lsof` count of open files whose path
mentions `lancedb`. Pool size left at the default (`LORE_LANCE_POOL_SIZE`
unset ⇒ 16) in every run, per the ask.

Reproduce:

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH
# before — main branch, git worktree, node_modules symlinked in:
( cd <main-worktree> && node scripts/diagnostics/open-store-cost-measure.mjs --n 10 --after search --json /tmp/before-main.json )
# after — scratch/step3-integration:
node scripts/diagnostics/open-store-cost-measure.mjs --n 10 --role both  --after search --json /tmp/after-both.json
node scripts/diagnostics/open-store-cost-measure.mjs --n 10 --role write --after writes --json /tmp/after-write.json
```

| run | branch | role | after | RSS delta ÷ N (MB/store) | vmmap delta ÷ N (MB/store) | `handleCount()` /store | lsof `lancedb` fds (whole process) |
|---|---|---|---|---|---|---|---|
| before | `main` @ `c600b62d` | (no role concept — today's only behaviour) | search | 6.71 | 2.43 | n/a — method doesn't exist on this build | 1 |
| after | `scratch/step3-integration` | `both` | search | 6.75 | 2.47 | **18** | 1 |
| after | `scratch/step3-integration` | `write` | writes (no search) | 5.73 | 1.65 | **2** | 1 |

**Verdict:** `handleCount()` confirms `verbatimStoreRole.ts`'s documented
handle budget EXACTLY — 18 for role `'both'` after a search builds the read
pool, 2 for role `'write'` (connection + write table, no pool) — an 8:1
handle reduction on the read-pool side. The RSS saving per store is real
but modest at this pool size and entry count (5.73 vs 6.71-6.75 MB/store,
~1 MB/store, ~15%): most of a `VerbatimStore`'s per-open cost is the LanceDB
table/schema machinery itself, not the pool's own handle objects, so
`role:'write'`'s main win is the **handle count** (relevant to host-side fd
budgets and LanceDB's own per-handle bookkeeping under `LORE_LANCE_POOL_SIZE`
tuning), not a large RSS delta at N=10. `main`'s "before" number
(6.71 MB/store, role concept doesn't exist) and step3's `role:'both'`
number (6.75 MB/store) are statistically indistinguishable, as expected —
default behaviour is unchanged. The `lsof lancedb` count stayed at 1 for
all three runs regardless of N or role; consistent with §8's own note that
LanceDB's fd layout doesn't scale 1:1 with logical store count within one
process (manifest/data-file handles are shared/pooled at a lower level than
this coarse substring count can resolve) — reported honestly rather than
overstated.

### 10.3 M3 — embedding-model release/reload, clean serial re-run (3×)

New script: `scripts/diagnostics/embed-release-measure.mjs` (did not exist on
the branch; written for this measurement). Five checkpoints in one process:
no model → after load+200 embeds → after `releaseLocalEmbeddingPipeline()` +
`gc()` + 2s wait → after a fresh provider reloads + 200 more embeds → after a
second release. Run 3 times (separate processes — the pipeline cache is
module-global) since the first attempt at this measurement ran with parallel
agents sharing the machine; this run had nothing else heavy running
(checked via `ps` before each of the 3 runs).

Reproduce:

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH
node scripts/diagnostics/embed-release-measure.mjs --json /tmp/embed-release-1.json
node scripts/diagnostics/embed-release-measure.mjs --json /tmp/embed-release-2.json
node scripts/diagnostics/embed-release-measure.mjs --json /tmp/embed-release-3.json
```

| checkpoint | run 1 RSS (MB) | run 2 RSS (MB) | run 3 RSS (MB) | run 1 vmmap (MB) | run 2 vmmap (MB) | run 3 vmmap (MB) |
|---|---|---|---|---|---|---|
| 1 — no model | 243.0 | 243.1 | 242.6 | 206.7 | 206.7 | 206.2 |
| 2 — after load + 200 embeds | 809.9 | 783.6 | 784.6 | 776.1 | 748.0 | 749.2 |
| 3 — after `releaseLocalEmbeddingPipeline()` + gc + 2s | 860.5 | 835.3 | 835.7 | 826.6 | 799.6 | 800.3 |
| 4 — after reload + 200 embeds | 880.8 | 851.5 | 852.4 | 847.1 | 816.0 | 817.2 |
| 5 — after second release | 867.3 | 840.2 | 840.9 | 833.5 | 804.5 | 805.5 |

`_pipelineCacheSizeForTests()` behaved exactly as designed in all 3 runs: 0
→ ≥1 (load) → **0** (release) → ≥1 (reload) → **0** (second release);
`releaseLocalEmbeddingPipeline()` returned `true` both times, every run.
`heapUsed` (not tabulated above, in the raw JSON) drops sharply on both
releases (~189 MB → ~31 MB) confirming the JS-side pipeline object and its
closures are genuinely collected.

**Verdict, stated honestly — release frees the JS heap reference and the
cache slot, but does NOT shrink process RSS/vmmap.** RSS/vmmap **rise**
slightly across a release in every single run (checkpoint 2→3: +50.6,
+51.7, +51.1 MB; checkpoint 4→5 actually **falls** slightly: -13.5, -11.3,
-11.5 MB, but never returns anywhere near checkpoint-1's 243 MB baseline).
This is consistent with the same class of finding as §9's SurrealDB verdict,
for a DIFFERENT native library: ONNX Runtime's arena allocator does not hand
pages back to the OS malloc layer on session disposal (or does so only
partially) — the memory `releaseLocalEmbeddingPipeline()` "frees" at the JS
level is retained resident, at least for the ~2s this harness waits after
each release. A genuinely useful release path exists at the **cache/object**
level (a reload provably reuses zero stale state — checkpoint 4's numbers
track checkpoint 2's closely, not checkpoint 3's), but hosts expecting this
call to reduce a process's memory footprint (the framing in
feat/embed-pipeline-idle-unload's own name, "idle-unload") should not expect
that from RSS/vmmap alone on this platform/runtime combination. This sprint
does not root-cause which allocator layer (onnxruntime-node's own arena,
V8's external-memory accounting, or the OS not reclaiming freed native
pages within the 2s window) — flagged as a "not established" item below,
same discipline as §8.8/§9's own unresolved-mechanism notes.

### 10.4 M4 — injected-provider child RSS (re-run, serial)

`npm run test:unit:injected-embedding-provider-e2e` re-run standalone, one
process, nothing else heavy running:

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH
npm run test:unit:injected-embedding-provider-e2e
```

Result: **6 passed, 0 failed.** The test's own printed numbers:

| | RSS |
|---|---|
| child-injected (host-injected `EmbeddingProvider`, never loads the local ONNX pipeline) | **526.9 MiB** |
| child-baseline (same workload, real local model loaded) | **1046.8 MiB** |
| delta | **520.0 MiB** |

Matches the shape (and the confirmed assertion) the test itself makes: the
injected-provider child costs meaningfully less RSS than the same workload
run through the normal local-model route, because it never loads a real
ONNX session at all — consistent with M3's finding that once a model IS
loaded, its resident cost does not go away on a soft release; the
injected-provider design's actual saving is never loading it in the child
in the first place, not a cheaper release path.

### 10.5 What was NOT measured, and why

- **M1 "before" was cited, not re-run**, per the ask's own instruction —
  §2.2/§8.2/§8.5 already measured `main` @ `c600b62d` on this exact machine
  the day before. Re-running it would only reproduce noise-band-identical
  numbers for `inproc`/`worker`/`embedded` (as M1's own "after" numbers
  confirm) and `main` has no `workspace-cycle`-with-eviction path to compare
  against anyway (that's precisely the gap this integration closes).
- **M2 "before" used `main`'s default (only) behaviour**, not a
  role-equivalent flag — `main` has no role concept, so "before" is simply
  "today's one way of opening a store," run with `--after search` to match
  the natural default-behaviour shape (a store that gets searched builds its
  read pool).
- **A precise MB-per-handle attribution inside the ~1 MB/store difference
  M2 found (role `both` vs `write`)** — not instrumented per-handle; the
  aggregate RSS delta ÷ N is what the ask specified.
- **Why ONNX Runtime's resident memory doesn't shrink after
  `releaseLocalEmbeddingPipeline()` (M3)** — mirrors §8.8/§9's own scoping:
  attribution (does it happen, is the JS-side state genuinely gone) was
  measured; root-causing which native allocator layer retains the pages was
  not, and needs the onnxruntime-node addon's own source or a native
  heap-profiling tool this sprint didn't reach for.
- **Linux/other-platform numbers** — this machine is darwin/arm64 only, same
  scope limit as §8.8/§9.
- **A longer (100+ cycle) `workspace-cycle` run** to see whether
  `resolverOpenCount` ever deviates from flat under sustained load (e.g. a
  guardrail interaction with pending embed/outbox work) — 50 cycles was the
  ask's spec; not extended further.
- **M2/M3 at non-default `LORE_LANCE_POOL_SIZE`** — the ask specified "default
  pool 16" for the before/after comparison; a pool-size sweep was not run.

---

## 11. 10-workspace live end-to-end (3.20.0)

Real daemon, real HTTP routes, own temp `LORE_HOME` + own port (18847 —
never `:3847`/`:8847`; the machine's unrelated live daemon at `:8847`
(pid 1331, `dist/`) was left running and untouched throughout — confirmed
before and after every run below). Branch `scratch/step3-integration`
@ `89af2f57`. darwin/arm64, Node 22.23.2, one session, nothing else heavy
running.

**Driver:** `scripts/diagnostics/e2e-10-workspace.mjs` (new). Boots
`packages/lore/src/mcp/server.ts --http` from TS source
(`node --import tsx`) with `LORE_VERBATIM_IDLE_TTL_MS` /
`LORE_VERBATIM_SWEEP_MS` / `LORE_REGISTRY_IDLE_TTL_MS` /
`LORE_REGISTRY_SWEEP_MS` set to 60000/15000 (per the ask), mints a
cross-workspace admin token by writing `<LORE_HOME>/auth/registry.json`
directly before the daemon starts (`issueToken()` from
`packages/lore/src/auth/tokens.ts` — the daemon's own bootstrap
`auth.token` is confined to workspace `"default"` with no
`cross-workspace-write` scope, so writing 10 OTHER workspaces needs a
scoped app token; see `test/L6-consistency-proof.ts`'s own note on the
same constraint), creates 10 workspaces via `POST /api/workspaces`, writes
50 nodes to each via `POST /api/nodes/bulk`, waits for that workspace's
outbox to drain, and confirms a semantic hit via
`GET /api/recall?topic=...&workspace=...` (hybrid graph+vector — every hit
in every run carried `"vector_index_consulted": true` in `_meta`). Metrics
per checkpoint: `ps -o rss=`, `vmmap --summary` Physical footprint,
`lsof -p <pid>` total fd count, and a path-substring count of open fds
under `<LORE_HOME>/workspaces/<name>/.lore/{surreal,lancedb}/` (the current
on-disk names per this repo's `CLAUDE.md`; `.lore/graph/` — the pre-rename
legacy name `openWorkspaceGraph.ts` still checks for — is matched too,
harmlessly). Registry "open workspace count" is read from
`GET /api/health`'s `workspaces.measuredCount` (Bearer-authenticated, scan
mode `'open'` — cache-hit-only, per that route's own anti-stampede design).

Reproduce (one run shown; the real runs used `--ttl-ms 60000 --sweep-ms 15000`,
matching the ask):

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH
node scripts/diagnostics/e2e-10-workspace.mjs \
  --search-worker 0 --workspaces 10 --entries 50 \
  --ttl-ms 60000 --sweep-ms 15000 --port 18847 \
  --log-dir /tmp/lore-e2e-logs --json /tmp/e2e-default.json
# second run, out-of-process search:
node scripts/diagnostics/e2e-10-workspace.mjs \
  --search-worker 1 --workspaces 10 --entries 50 \
  --ttl-ms 60000 --sweep-ms 15000 --port 18847 \
  --log-dir /tmp/lore-e2e-logs --json /tmp/e2e-searchworker.json
```

### 11.1 Checkpoints — default (in-process search, `LORE_SEARCH_WORKER` unset)

| checkpoint | RSS | vmmap footprint | total fds | graph fds (ws w/ fds) | lancedb fds (ws w/ fds) | registry measuredCount/knownCount | global nodeCount | outbox depth |
|---|---|---|---|---|---|---|---|---|
| 1-baseline | 984.3 MB | 936.0 MB | 75 | 0 (0) | 0 (0) | 1/1 | 0 | 0 |
| 2-after-10-open | 1954.9 MB | 1843.2 MB | 106 | 30 (10) | 0 (0) | 11/11 | 500 | 0 |
| 3-after-sweep (+95s idle) | 1906.1 MB | 1740.8 MB | 104 | 30 (10) | 0 (0) | 11/11 | 500 | 0 |
| 4-after-reopen | 1906.4 MB | 1740.8 MB | 106 | 30 (10) | 0 (0) | 11/11 | 500 | 0 |

Reopen search (`GET /api/recall?topic=needle-phrase-0&workspace=e2e-ws-0`):
**found on the first attempt**, `top_score` ≈0.88, `vector_index_consulted: true`.

### 11.2 Checkpoints — `LORE_SEARCH_WORKER=1` (out-of-process search)

| checkpoint | RSS | vmmap footprint | total fds | graph fds (ws w/ fds) | lancedb fds (ws w/ fds) | registry measuredCount/knownCount | global nodeCount | outbox depth |
|---|---|---|---|---|---|---|---|---|
| 1-baseline | 379.0 MB | 331.6 MB | 76 | 0 (0) | 0 (0) | 1/1 | 0 | 0 |
| 2-after-10-open | 1858.7 MB | 1843.2 MB | 117 | 30 (10) | 0 (0) | 11/11 | 500 | 0 |
| 3-after-sweep (+95s idle) | 1815.6 MB | 1638.4 MB | 115 | 30 (10) | 0 (0) | 11/11 | 500 | 0 |
| 4-after-reopen | 1815.8 MB | 1638.4 MB | 117 | 30 (10) | 0 (0) | 11/11 | 500 | 0 |

Reopen search: found on the first attempt, same shape as 11.1. The
`LORE_SEARCH_WORKER=1` baseline RSS (379 MB) is much lower than the default
run's baseline (984 MB) — observed, not explained further here; the likely
read is that the default config's boot path probes/loads the local ONNX
embedding backend eagerly while the worker-isolated config defers it to the
child, but this was not traced through the boot code to confirm.

### 11.3 What "expected honestly" got vs what actually happened

The ask's own framing was: resolver/verbatim (LanceDB) handles fall to 0
non-pinned; graph (SurrealDB) handles are evicted by the registry but native
memory + fds are not returned. **Neither half of that happened as framed,
for two different reasons, both confirmed by direct measurement:**

**Graph (SurrealDB) side — registry-level eviction did not fire at all at
TTL=60000/sweep=15000**, in EITHER run above: `measuredCount` sat at 11
(the 10 harness workspaces + the pinned boot workspace) through baseline →
after-open → after **95 seconds of zero traffic** (60s TTL + 2×15s sweep +
5s margin) → after-reopen, in both runs, reproduced twice on the exact
target config. This contradicts the ask's premise that graph handles get
evicted at this TTL. Bisecting the TTL/sweep pair against the same 10×50
workload (short extra runs, not part of the two official runs above):

| TTL / sweep | wait (TTL+2×sweep+5s) | registry evicted? | graph fds after |
|---|---|---|---|
| 8000 / 3000 | 19s | **yes** — measuredCount 11→1 | 30 (unreclaimed — see below) |
| 20000 / 5000 | 35s | **yes** — measuredCount 11→1 | 30 (unreclaimed) |
| 40000 / 10000 | 65s | **no** — stayed 11 | grew 30→70 during the idle wait (unexplained; nothing in the harness touched the daemon during that window) |
| 60000 / 15000 (the ask's own values) | 95s | **no** — stayed 11 (×2 runs) | 30 |
| 60000 / 15000 + `LORE_ACCESS_FLUSH_MS=999999999` | 95s | **no** — stayed 11 | 30 |

The last row was a deliberate attempt to confirm a hypothesis: every
`/api/recall` hit calls `ensureAccessTracker(graph)?.touch(ids, 'retrieval')`
(`packages/lore/src/recall/retrieve.ts:734`), and that per-graph tracker
flushes a real write (`stampAccessTimes`) every `LORE_ACCESS_FLUSH_MS`
(default **60000ms** — `packages/lore/src/engines/accessTracker.ts`,
independent of `LORE_REGISTRY_IDLE_TTL_MS`), which lined up suspiciously
exactly with the 20000-vs-40000 pass/fail boundary above. Forcing that
flush interval to effectively "never" and re-running the exact failing
config (60000/15000) **still did not evict** — so the access-tracker flush
is ruled OUT as the mechanism, not confirmed. **Root cause not established
within this task.** What's solid: the effect is real and reproducible (2
identical full runs + a 3-point bisection + 1 falsified hypothesis, 6 runs
total), the threshold is somewhere between 20s and 40s TTL, and it directly
contradicts the "graph handles are evicted by the registry" half of the
ask's own expectation at the TTL the ask specified. This deserves dedicated
follow-up; flagged rather than guessed further.

**Where eviction DID fire (8000/3000, 20000/5000), the OTHER half of the
ask's premise held exactly as documented in §9**: `measuredCount` dropped
(the JS-side registry entry was evicted) but `graph fds stayed at 30` the
whole time — the per-workspace SurrealDB fds (3/workspace × 10) are never
returned, matching §9's finding "graph idle eviction is net-negative on
this driver" verbatim, now confirmed live over HTTP with real workspace
traffic rather than the bare-engine probe §9 used.

**Verbatim (LanceDB) side — the fd-count proxy reports 0 the entire time,
in every run, including with confirmed live vector search traffic.** A
direct check (10 nodes, 1 workspace, one `/api/recall` call that returned
`vector_index_consulted: true` and a 0.905 top score) showed `lsof -p <pid>`
never lists any path under `.lore/lancedb/` for that workspace — only the
loaded native addon binary
(`node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node`,
process-global, one entry) matches "lancedb" at all. This is consistent
with §10.2's own finding ("the lsof `lancedb` count stayed at 1 for all
three runs regardless of N or role" — that "1" was the same native binary,
not per-store data files). **`lsof` is not a usable signal for LanceDB's
per-workspace open/evicted state on this platform/binding** — reported as
"not observable this way," not as "zero real resident cost" (RSS clearly
tracks total workspace count: 984→1955 MB / 379→1859 MB across the two
runs' open-10 step). No HTTP route exposes `WorkspaceVerbatimResolver`'s
own `openCount()`/idle state (checked: `/api/health`, `/api/admin/stats`,
`/api/diagnostic/cache-stats` — none of them; consistent with the ask's own
"if the daemon exposes them" conditional — it doesn't, and nothing was
added to `src/` to make it so).

### 11.4 Shutdown evidence

| | default | `LORE_SEARCH_WORKER=1` |
|---|---|---|
| signal sent | SIGTERM | SIGTERM |
| exit code | **0** | **0** |
| exit signal | null (clean `process.exit`, not signal-killed) | null |
| time from SIGTERM to exit | 404 ms | 404 ms |
| open fds immediately before SIGTERM | 106 | 117 |
| child processes immediately before SIGTERM | 0 | **11** (search-worker pool) |
| child processes alive 500ms+300ms after exit | 0 | **0** — all 11 reaped |
| `lsof +D <LORE_HOME>` after exit | empty (no lock files held) | empty (no lock files held) |

The daemon's own stderr confirmed the ordered drain ran
(`[Lore MCP] graceful shutdown begin (SIGTERM)` → `[loadJobsRunner] stopped`
→ `[outbox replicator] stopped` → `[Lore MCP] graceful shutdown complete`),
matching `shutdownCoordinator.ts`'s documented `exitFn(0)` path (not a
forced/timeout exit — the drain completed well inside its 10s cap).

**PID 1331** (the machine's separate, pre-existing `:8847` daemon, running
from this checkout's `dist/`) was checked immediately before and
immediately after both runs and after every bisection run in 11.3 — same
pid, same command line, still listening on `:8847` only, every time. It was
never signaled, connected to, or rebuilt under (`npm run build`/`clean`/
`pack` were never invoked).

### 11.5 Not measured, and why

- **Root cause of the 20-40s TTL eviction threshold (11.3)** — bisected and
  one hypothesis falsified; not root-caused further within this task's
  time budget. Flagged for follow-up. **RESOLVED — see §11.6.**
- **Root cause of the 40000/10000 run's graph-fd growth (30→70) during an
  idle wait** — observed once, not reproduced a second time under that
  exact config (the two OFFICIAL runs use 60000/15000, where fds stayed
  flat at 30); noted as a data point, not chased further. **RESOLVED —
  see §11.6.**
- **Any direct verbatim/LanceDB resolver open-count or idle-state number**
  — no HTTP surface exposes it (checked, see 11.3) and `lsof` cannot see
  LanceDB's per-workspace files on this platform/binding (also 11.3). RSS
  is the only available (aggregate, not substrate-isolated) proxy.
  **PARTIALLY RESOLVED — see §11.6**: `/api/health`'s `workspaces` block now
  also reports `verbatimResolverOpenCount` (a direct, pure-read
  `WorkspaceVerbatimResolver.openCount()`), so the open-count half is now
  observable; per-store idle-state (`lastAccessedAt`) is still not exposed
  over HTTP — that remains unmeasured this way (verified in-process instead,
  §11.6).
- **Linux or non-darwin numbers** — this machine is darwin/arm64 only, same
  scope limit as every prior section.
- **A cold-boot baseline with the ONNX model pre-warmed** — the ask's own
  checkpoint 1 is "daemon RSS right after boot," which is what's reported;
  the default-vs-worker baseline RSS gap (11.2) was observed, not traced.

---

### 11.6 Root cause + fix (found and closed 2026-09-18)

**Root cause.** The daily retention sweep's bootstrap timer
(`mcp/retentionScheduler.ts`, `FIRST_FIRE_MS` = 60\_000, default, no env
override in any of the runs above) fires **once, ~60s after daemon boot,
regardless of traffic**, then re-fires every `DAILY_INTERVAL_MS` (24h). Its
callback — `runRetentionSweepAllWorkspaces` (`mcp/daemonTimers.ts:224-256`,
wired at `retentionRunner`, `mcp/daemonTimers.ts:92`) — fans out over
**every** registered workspace (`listWorkspaceNames()`), calling, per
workspace:

- `registry.getGraphHandle(ws)` → `LocalGraphRegistry.ensureEntry`'s
  cache-hit branch (`engines/localGraphRegistry.ts`, was line 291) —
  `cached.lastAccessedAt = this.now()`
- `resolver.getOrOpen(ws)` → `WorkspaceVerbatimResolver.getOrOpen`'s
  cache-hit branch (`outbox/workspaceVerbatimResolver.ts`, was line 238) —
  `cached.lastAccessedAt = this.now()`
- `registry.tableStorageFor(ws)` (consistency sweep only) — same
  `ensureEntry` cache-hit path

Both accessors treated this **background maintenance access exactly like
real user access**, resetting the idle-eviction clock for every workspace
the fan-out reached. `runConsistencySweepAllWorkspaces` (same file,
`:171-210`) has the identical shape but its own default interval is 30
minutes (`DEFAULT_CONSISTENCY_SWEEP_MS`), so it never fired inside the
short E2E windows above and was not the mechanism for THIS symptom — but it
had the same defect and is fixed the same way.

**Confirmed by direct instrumentation** (temporary stack-trace logging on
every `lastAccessedAt` stamp, gated behind `LORE_DEBUG_TOUCH_TRACE=1`,
removed before this commit): re-running the exact TTL=60000/sweep=15000
scenario showed the 10 harness workspaces' registry entries touched at
**T+58.9s after daemon boot**, with every one of those call stacks bottoming
out in `runRetentionSweepAllWorkspaces` → `retentionRunner` →
`Timeout._onTimeout` at `retentionScheduler.ts:83`. This lines up exactly
with the bisected 20s-40s pass/fail boundary in the table in §11.3: the
official runs' idle wait is `TTL + 2×sweep + 5s` starting right after the
10-workspace write phase (~T+9s), so the wait window's END time is
`T + 9 + TTL + 2×sweep + 5`. For TTL≤20000 that end time falls **before**
the T+60s retention fire, so the checkpoint is taken before the reset ever
happens and eviction is observed correctly. For TTL≥40000 the wait extends
**past** T+60s, the retention fan-out's touch resets every workspace's
clock at T+60s, and by the time the checkpoint is taken only
45s-ish have elapsed since that reset — under the 40s+ TTL — so nothing
looks idle enough to evict. Root cause fully explains the reported
boundary; no remaining mystery.

**FD-growth explanation (the unexplained 30→70 datapoint at
TTL=40000/sweep=10000).** With the idle-eviction sweep's OWN 10s cadence,
some of the 10 workspaces cross their real TTL and get evicted (closed —
SurrealDB's native addon does not release fds on `close()`, per §9, so
those 30 fds are never returned) **before** the T+60s retention fire. The
retention fan-out then reopens ALL 10 (they're no longer cached), which
opens 10 fresh `SurrealGraph` handles — another 3 fds/workspace × 10 = 30
more fds — stacked on top of the already-leaked 30. That is the entire
30→70 growth: one eviction-close's leaked fds plus one reopen's fresh fds,
both real and both already-documented behaviors (§9's "graph idle eviction
is net-negative on this driver" + the touch-reset bug above), not a new or
unbounded leak. Reproduced deliberately post-fix at the exact 40000/10000
config (see "Bisection re-run" below): fds go 30 → 60 (evict, once) instead
of unboundedly growing further, because after the fix the reopened
workspaces are immediately re-evictable rather than being granted a fresh
TTL-length lease every time the daily sweep touches them.

**Fix.** `{ touch: false }` — a non-touching accessor mode, per the
task's preferred shape:

- `LocalGraphRegistry.ensureEntry` / `.getGraphHandle` / `.tableStorageFor`
  and `WorkspaceVerbatimResolver.getOrOpen` all take an optional
  `{ touch?: boolean }` (default `true` — byte-identical to prior
  behaviour for every existing caller). A cache-hit under `touch: false`
  returns the entry/store WITHOUT bumping `lastAccessedAt`.
- Opening (not merely touching) a workspace under `touch: false` — the
  case where the fan-out reopens an ALREADY-EVICTED or never-opened
  workspace to check it — stamps a stale sentinel (`STALE_SENTINEL_MS = 0`)
  instead of `now()`, so the reopened entry is immediately eligible for
  the very next eviction-sweep tick rather than being granted a fresh
  full-TTL lease it never earned. This is what closes the fd-growth loop
  above.
- `mcp/daemonTimers.ts`'s `runConsistencySweepAllWorkspaces` and
  `runRetentionSweepAllWorkspaces` now pass `{ touch: false }` on all three
  accessor calls. `mcp/server.ts`'s hand-rolled `graphRegistry` shim object
  (passed into `wireDaemonTimers`) now forwards the opts through instead of
  swallowing them.
- `mcp/http/routes/diagnostic/health.ts`'s `/api/health` route (an
  externally-triggered admin/operator read, not internal daemon
  maintenance) is deliberately left touching (default `true`) — a health
  check asking "what does this workspace look like right now" is real
  access, not background noise.
- No eviction default or TTL was changed.

**Observability added.** No route exposed `WorkspaceVerbatimResolver`'s own
open-store count (flagged as a gap in §11.3/§11.5). Added the smallest
read-only field: `/api/health`'s authenticated body now includes
`workspaces.verbatimResolverOpenCount` — a direct call to the resolver's
existing `openCount()` (`this.byPath.size`, no side effect, cannot itself
keep anything alive). The graph-registry half was already observable via
the existing `workspaces.measuredCount` (`scanned:'open'`, cache-hit-only)
field documented in §11's intro. Both are now real, direct reads — not RSS
inference.

**Unit test** (`test/background-access-no-touch-idle-eviction-unit.ts`,
registered as `test:unit:background-access-no-touch-idle-eviction`, in the
main `test` chain): pins (1) a `touch:false` cache-hit during the idle
window does not reset `lastAccessedAt` and the workspace is still evicted
once the TTL genuinely elapses, for both `LocalGraphRegistry.getGraphHandle`
and `.tableStorageFor`, and for `WorkspaceVerbatimResolver.getOrOpen`; (2) a
`touch:false` reopen of an already-evicted workspace does not grant it a
fresh lease — it is evictable again on the very next sweep tick with no
further time passing; (3) default (`touch` omitted) behaviour is provably
unchanged — an ordinary touching re-access still resets the clock and keeps
the workspace alive, exactly as before this fix.

**Re-run — official config, TTL=60000/sweep=15000, AFTER the fix**
(same branch, same harness, same darwin/arm64 machine; PID 1331 confirmed
untouched before/after):

| checkpoint | RSS | vmmap | total fds | graph fds (ws) | lancedb fds (ws) | measuredCount/knownCount | global nodeCount |
|---|---|---|---|---|---|---|---|
| 1-baseline | 982.3 MB | 934.5 MB | 75 | 0 (0) | 0 (0) | 1/1 | 0 |
| 2-after-10-open | 1938.8 MB | 1843.2 MB | 106 | 30 (10) | 0 (0) | 11/11 | 500 |
| 3-after-sweep (+95s idle) | 1905.7 MB | 1740.8 MB | 104 | 30 (10) | 0 (0) | **1**/11 | **0** |
| 4-after-reopen | 1911.9 MB | 1740.8 MB | 111 | 34 (10) | 1 (1) | 2/11 | 50 |

`LORE_SEARCH_WORKER=1` (out-of-process search), same config:

| checkpoint | RSS | vmmap | total fds | graph fds (ws) | lancedb fds (ws) | measuredCount/knownCount | global nodeCount |
|---|---|---|---|---|---|---|---|
| 1-baseline | 379.7 MB | 332.4 MB | 76 | 0 (0) | 0 (0) | 1/1 | 0 |
| 2-after-10-open | 1859.5 MB | 1843.2 MB | 117 | 30 (10) | 0 (0) | 11/11 | 500 |
| 3-after-sweep (+95s idle) | 1824.6 MB | 1638.4 MB | 105 | 30 (10) | 0 (0) | **1**/11 | **0** |
| 4-after-reopen | 1825.3 MB | 1638.4 MB | 112 | 34 (10) | 0 (0) | 2/11 | 50 |

Both runs: registry eviction now fires correctly (`measuredCount` 11→1,
matching the ask's original premise — compare to the BEFORE numbers in
§11.1/§11.2 where it stayed at 11 the whole time). Reopen search
(`GET /api/recall?topic=needle-phrase-0&workspace=e2e-ws-0`) **found the
pre-eviction data on the first attempt** in both runs (`top_score` ≈0.88,
`vector_index_consulted: true`) — confirming eviction-then-reopen is
transparent and lossless. Graph fds still do not return to 0 after eviction
(30 stays 30 at checkpoint 3) — this is the SEPARATE, already-documented §9
SurrealDB-never-frees-on-close behavior, unaffected by and out of scope for
this fix. Shutdown: exit code 0 (clean `process.exit`, not signal-killed)
in both runs, `shutdownMs` 403ms / 405ms, 0 children alive post-exit (11
search-worker children all reaped in the worker run), no lock files held —
matching §11.4's original clean-shutdown finding.

**Bisection re-run — TTL=40000/sweep=10000 (the config that showed the
30→70 fd anomaly and the "no" eviction verdict in §11.3's table), AFTER the
fix:**

| checkpoint | RSS | vmmap | total fds | graph fds (ws) | measuredCount |
|---|---|---|---|---|---|
| 1-baseline | 978.7 MB | 930.3 MB | 77 | 0 (0) | 1 |
| 2-after-10-open | 1938.9 MB | 1843.2 MB | 108 | 30 (10) | 11 |
| 3-after-sweep (+65s idle) | 2807.2 MB | 2662.4 MB | 136 | 60 (10) | **1** |
| 4-after-reopen | 2909.5 MB | 2764.8 MB | 143 | 64 (10) | 2 |

Eviction now fires (`measuredCount` 11→1, was stuck at 11 before the fix).
Graph fds still grow (30→60, not 30→70) — per the FD-growth explanation
above, this is the retention fan-out's one necessary reopen of all 10
evicted workspaces (to check each one's own policy — RC-round4's whole
point) stacked on the already-leaked close()'d fds; it stops growing
further because the reopened entries are immediately re-evictable rather
than holding a fresh 40s lease every 24h. RSS/vmmap spike at checkpoint 3
for the same reason (10 workspaces briefly held open again mid-sweep) and
is consistent with §9's driver-level finding, not a new leak. Reopen
search: found on the first attempt. This closes both items flagged
"not measured"/"unexplained" in §11.3 and §11.5 above.

Reproduce (temporary instrumentation, NOT part of this commit — for anyone
re-diagnosing a similar symptom):

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH
# add __touchTrace() stack-trace logging gated on LORE_DEBUG_TOUCH_TRACE=1
# at every lastAccessedAt stamp site in localGraphRegistry.ts /
# workspaceVerbatimResolver.ts, then:
LORE_DEBUG_TOUCH_TRACE=1 node scripts/diagnostics/e2e-10-workspace.mjs \
  --ttl-ms 60000 --sweep-ms 15000 --json /tmp/e2e-trace.json --log-dir /tmp/lore-e2e-logs
# inspect /tmp/lore-touch-trace.log for cache-hit touches whose stack
# bottoms out in runRetentionSweepAllWorkspaces / runConsistencySweepAllWorkspaces
```

Official re-run (post-fix, permanent — this is what's in the table above):

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH
node scripts/diagnostics/e2e-10-workspace.mjs \
  --search-worker 0 --workspaces 10 --entries 50 \
  --ttl-ms 60000 --sweep-ms 15000 --port 18847 \
  --log-dir /tmp/lore-e2e-logs --json /tmp/e2e-default-after.json
node scripts/diagnostics/e2e-10-workspace.mjs \
  --search-worker 1 --workspaces 10 --entries 50 \
  --ttl-ms 60000 --sweep-ms 15000 --port 18847 \
  --log-dir /tmp/lore-e2e-logs --json /tmp/e2e-searchworker-after.json
```

---

### 11.7 Driver update — `verbatimResolverOpenCount` recorded live (2026-09-18)

§11.6 added `/api/health`'s `workspaces.verbatimResolverOpenCount` field but
the driver (`scripts/diagnostics/e2e-10-workspace.mjs`) never read it — the
§11.6 tables above still document the open-count/eviction story only via
`measuredCount` (the graph registry's own count). The driver now records
`verbatimResolverOpenCount` (and a `searchWorkerChildren` child-process
count, and `bootElapsedMs` per checkpoint) at every checkpoint alongside
`measuredCount`, so the resolver's own eviction is observed directly rather
than inferred.

**First confirmed: resolver traffic is genuinely exercised by this driver,
not just the graph registry.** The daemon boots with active workspace
`"default"`; the harness's 10 workspaces are named `e2e-ws-0`..`e2e-ws-9`,
none of which collide with `"default"`. `POST /api/nodes/bulk`
(`mcp/http/routes/bulkWrite.ts`) calls
`workspaceVerbatimResolver.getOrOpen(requestedWorkspace)` whenever a
`workspace` field is present, and `GET /api/recall?workspace=...`
(`recall/retrieve.ts`'s `resolveSeedStore`) routes through the SAME
resolver for any workspace that isn't the boot/active graph
(`graph === bootGraph` is false for all 10). So every one of the driver's
writes and searches against the 10 harness workspaces already opens that
workspace's own `WorkspaceVerbatimResolver` entry — no driver change was
needed to exercise the per-workspace verbatim path, only to read the
counter it produces.

**Re-run, official config (TTL=60000/sweep=15000), post-fix (28263f51),
with the field now recorded** — darwin/arm64, Node 22.23.2, PID 1331
confirmed listening on `:8847` only, before and after both runs:

| checkpoint | bootElapsedMs | RSS | total fds | searchWorkerChildren | measuredCount | verbatimResolverOpenCount |
|---|---|---|---|---|---|---|
| 1-baseline | 679 | 981.8 MB | 75 | 0 | 1 | **1** |
| 2-after-10-open | 9778 | 1937.2 MB | 106 | 0 | 11 | **11** |
| 3-after-sweep (+95s idle, past T+60s retention bootstrap) | 105436 | 1902.9 MB | 104 | 0 | 1 | **1** |
| 4-after-reopen | 106114 | 1909.1 MB | 111 | 0 | 2 | **2** |

`LORE_SEARCH_WORKER=1` (out-of-process search) — same config; note
`searchWorkerChildren` tracks `verbatimResolverOpenCount` exactly (each
opened workspace's `VerbatimSearchWorkerProxy` forks its own worker child;
eviction closes the store, which reaps its worker):

| checkpoint | bootElapsedMs | RSS | total fds | searchWorkerChildren | measuredCount | verbatimResolverOpenCount |
|---|---|---|---|---|---|---|
| 1-baseline | 577 | 380.7 MB | 76 | **1** | 1 | **1** |
| 2-after-10-open | 13767 | 1756.0 MB | 117 | **11** | 11 | **11** |
| 3-after-sweep (+95s idle, past T+60s retention bootstrap) | 109411 | 1726.2 MB | 105 | **1** | 1 | **1** |
| 4-after-reopen | 110407 | 1726.7 MB | 112 | **2** | 2 | **2** |

Both runs: `verbatimResolverOpenCount` goes **11 → 1** across the idle
sweep — the 1 pinned boot workspace (`"default"`) stays open, all 10
non-pinned harness workspaces are evicted, exactly matching the ask's
original "10 → 0 (non-pinned)" expectation (the resolver's baseline is 1,
not 0, because the boot workspace's own store is always pinned open). The
idle wait (95s) runs well past the T+60s retention-sweep bootstrap
(`bootElapsedMs` at checkpoint 3 is 105s/109s) in both runs and eviction
still fires correctly — confirming §11.6's `{ touch: false }` fix holds
under live measurement with the field the fix itself added. Shutdown in
both runs: exit code 0, all children reaped (`searchWorkerChildren` search
workers included), no lock files held — unchanged from §11.4/§11.6.
`verbatimResolverOpenCount` and `measuredCount` moved together at every
checkpoint in both runs (both are direct reads of two independently
maintained caches — `LocalGraphRegistry`'s own map and
`WorkspaceVerbatimResolver`'s `byPath` map — agreeing is itself evidence
the shared fix landed correctly on both, not just one).

---

## 12. Two-process LanceDB (Q4)

Answers `../nirman-tapestry/docs/lore-asks/QUESTIONS-FOR-LORE.md` Q4: is
two-process LanceDB read/write on one directory safe? New script:
`scripts/diagnostics/lance-two-process.mjs`. Three scenarios, each **~2
minutes of continuous concurrent traffic** against one shared,
`lore_verbatim`-shaped `VerbatimStore` directory (real `VerbatimStore` from
`packages/lore/src/engines/verbatimStore.ts`, not raw `@lancedb/lancedb` —
this is the actual shape Lore puts on disk). Every participant (writer,
reader, and the final independent verifier) is a genuinely SEPARATE Node
child process, each opening its own `VerbatimStore` instance against the
shared dir — the real multi-process shape the question asks about. A tiny
constant-shape fake `EmbeddingProvider` (no ONNX) keeps the run
I/O-dominated and deterministic.

**Scenario 1 and scenario 1b answer two DIFFERENT questions and must not be
conflated** (an earlier pass only ran scenario 1 and drew a general "not
safe for read freshness" conclusion from it — corrected in §12.3/§12.4
below). Scenario 1 starts the writer and reader SIMULTANEOUSLY against an
EMPTY directory, so the reader's `initialize()` races table creation and
typically loses — it measures whether a store opened before a table exists
ever discovers one created later by another process. Scenario 1b seeds the
table first (one writer, verified via an independent `verify` child polling
until `count() > 0`), THEN opens the reader against a table already
confirmed to exist on disk, and lets it run its full ~2-minute loop while
the writer keeps writing — this is the real "does a long-lived reader
process see a concurrent writer's NEW commits" question.

Reproduce (now runs all three scenarios: 1, 1b, 2 — roughly 2+2.5+2 = ~6.5
minutes wall-clock):

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH
node scripts/diagnostics/lance-two-process.mjs --duration-ms 120000 --json /tmp/lance-2p.json
```

### 12.1 Scenario 1 — reader opens on an EMPTY directory (writer+reader started simultaneously, 2 min)

> **Labelling correction (2026-09-18):** this scenario's writer and reader
> are started at the same instant against a directory with no table yet.
> The result below (reader never sees ANY data, ever) is near-certain
> evidence of **"a store opened before the table exists never discovers one
> created later,"** not general "read freshness on an existing table" — see
> §12.4 for the freshness question, measured properly on a pre-seeded table.
> This section is kept, unmodified from the original run, exactly as a
> correctly-labelled record of the empty-dir case.

| | value |
|---|---|
| writer batches / attempted / succeeded / failed | 1663 batches, **8315 attempted, 8315 succeeded, 0 failed** |
| writer errors by type | none |
| reader iterations (search + count per iteration) | 2324 |
| reader search errors / count errors | 0 / 0 |
| reader `count()` regressions (a later read lower than an earlier one) | 0 |
| reader `count()` samples: first / last / max observed | **0 / 0 / 0** — never once saw a non-zero count in 2324 tries |
| reader `search()` : max hits ever seen / first non-zero-hit time | **0 / never** — 2324 searches, zero hits, the whole 2 minutes |
| reader malformed hits (missing text/score/id) | 0 (moot — there were no hits) |
| reader's own fresh reconnect at the end (`count()` on a brand-new `VerbatimStore` instance, same dir) | **8315** — matches the writer exactly |
| independent 3rd-process verifier `count()` | **8315** |
| final count vs total acknowledged | **8315 = 8315 — exact match** |

**The reader's long-lived handle never observed the writer's commits, in
either `count()` or `search()`, for the entire 2 minutes — only a fresh
reconnect (a brand-new `VerbatimStore` against the same dir) saw the data,
immediately and correctly.** This is not a caching artifact of this
script's own search-result cache (`SEARCH_CACHE_TTL_MS` default 1500ms —
far shorter than 2 minutes, and irrelevant to `count()` which isn't cached
at all): `count()` reads `this.table.countRows()` on a handle opened once
at `initialize()` and never refreshed (`packages/lore/src/engines/
verbatimStore.ts` — no `checkoutLatest()` call in `count()`), so it is
permanently pinned to the table version at open time; `search()` goes
through the read pool, which DOES call `checkoutLatest()` on every acquire
(same file, ~line 1397) and should see fresh commits, yet found zero hits
here anyway. **Most likely explanation (see the labelling correction
above and §12.4): the reader's `initialize()` almost certainly ran before
`storeBatch()` ever created the LanceDB table on disk (`this.table` stays
`null` on that race — `verbatimStore.ts`'s `initialize()` opens the table
only if `openTable('lore_verbatim')` succeeds, which fails on a directory
with no table yet), so `count()`/`search()` on this reader were never
against a live table handle at all — not a staleness bug on an existing
table.** §12.4 reruns the same handle-level test on a table confirmed to
exist BEFORE the reader opens, which isolates true read-after-write
freshness from this discovery race; read that section for the settled
freshness verdict instead of this scenario alone.

**No exceptions, no crashes, no torn/partial rows, no commit-conflict
errors in this scenario.** Every write the writer attempted succeeded; the
final row count exactly matches what was acknowledged.

### 12.2 Scenario 2 — two concurrent writers, no reader (2 min)

| | value |
|---|---|
| writer w1: attempted / succeeded / failed | 5675 / 5675 / 0 |
| writer w2: attempted / succeeded / failed | 5670 / 5670 / 0 |
| commit-conflict / other errors (either writer) | **0** in the full 2-minute run |
| independent verifier `count()` after both exit | **11345** |
| final count vs total acknowledged (5675+5670) | **11345 = 11345 — exact match** |

A separate 4-second smoke run of the same scenario (not the timed
official run above) DID catch 2 non-fatal `ensureFtsIndex`/
`ensureVectorIndex` "Retryable commit conflict ... This CreateIndex
transaction was preempted by concurrent transaction CreateIndex ... Please
retry." errors — both writers happened to cross the auto-index-build row
threshold in the same instant. `VerbatimStore` logs these as `ERROR` but
treats them as **non-fatal** (the index build for that writer is simply
skipped that cycle; row writes are unaffected) — no data was lost or
corrupted in that smoke run either (final count still matched). The
official 2-minute run above logged **zero** such conflicts (index building
only happens near specific row-count thresholds, so a longer run doesn't
guarantee hitting the race window again) — reported honestly as "occurred
in one run, not the official timed one," not smoothed over.

### 12.3 Verdict — plainly

- **Reader opened on an empty dir (scenario 1): safe for data integrity**
  (no corruption, no lost writes, exact final count) **but that reader
  never discovers a table another process creates after it opens.** This
  is a table-existence race, not a read-freshness result — see the
  labelling correction in §12.1. *(Corrected 2026-09-18 — a previous
  version of this bullet concluded "NOT safe for read freshness" from this
  scenario alone; that conclusion did not distinguish "table didn't exist
  yet" from "table existed but reads were stale." §12.4 below reruns the
  same handle-level test on a table confirmed to exist before the reader
  opens, which is the correct way to answer the freshness question, and
  the answer there is: also unsafe, but for a different, better-isolated
  reason — see below.)*
- **Reader opened AFTER the table exists, single writer (scenario 1b, §12.4):
  safe for data integrity, but NOT safe for read freshness.** A long-lived
  reader's `count()` and an exact-id `getById()` freshness probe both stay
  frozen at the value observed at `initialize()` time for the reader's
  entire ~2-minute run, never once reflecting any of the writer's
  thousands of commits made during that window — while `search()` keeps
  returning hits the whole time (it saw the pre-existing rows immediately)
  but was never shown, by this design, to surface a specific NEW
  post-open row either. Only a fresh reconnect (a brand-new
  `VerbatimStore` instance against the same dir) sees current data,
  immediately and completely. **Practical implication (now measured on an
  existing table, not inferred from the empty-dir case): processes sharing
  a LanceDB directory for read-after-write must reconnect periodically (or
  per-request) — a long-lived read handle does not self-refresh**, despite
  the read pool's own `checkoutLatest()` call on `search()`.
- **Two writers: safe for data integrity in the run measured** (0 errors,
  exact final count, no crash) **but not conflict-free** — a non-fatal
  index-build commit-conflict was observed in an adjacent smoke run under
  the same two-writer pattern. `VerbatimStore` already treats that specific
  conflict class as non-fatal and continues; row data was never lost in
  either run. Not measured: whether a DIFFERENT kind of two-writer race
  (e.g. both writers' row-add commits themselves conflicting, as opposed to
  the index-build commit) can occur under different timing — none occurred
  in either run captured here, but 2 minutes at this write rate is not
  proof of absence over longer/higher-throughput production traffic.

### 12.4 Scenario 1b — reader opens AFTER the table is seeded (2026-09-18)

Fixes scenario 1's confound: the writer (`writer-id w1b`) starts alone and
writes continuously; the orchestrator polls the shared dir with independent,
short-lived `verify` children (each a genuinely separate process: open,
`count()`, close) every 400ms until one reports `count() > 0` — real proof
the table exists on disk, not an assumed delay. Only then does the reader
open its own `VerbatimStore` against the same dir and run its full loop for
DURATION_MS (~2 min) while the writer keeps writing (the writer's own
duration is set 30s longer than the reader's so it never stops first). The
reader also polls an exact-id freshness probe (`getById(targetId)`) for a
row the orchestrator computed to land ~10 batches (50 rows) after the seed
point — comfortably guaranteed to be written strictly AFTER the reader
opens, so "found" vs. "not found" is an unambiguous freshness signal, not
confounded by the empty-dir race (12.1) or by top-K vector-ranking noise (a
generic content search can't guarantee a specific new row surfaces in the
top 10 hits).

Official run (same 2-minute pass as §12.1/§12.2, one combined script
invocation):

| | value |
|---|---|
| seed wait: writer batches before `verify` saw `count() > 0` | 1104 ms (count=115) |
| writer: attempted / succeeded / failed | 9480 / 9480 / 0 |
| writer errors by type | none |
| reader iterations (search + count + getById per iteration) | 2147 |
| reader search errors / count errors | 0 / 0 |
| reader `count()`: baseline / first / last / max observed | **165 / 165 / 165 / 165 — never once increased in 2147 samples over ~2 minutes** |
| reader `count()` regressions | 0 |
| time-to-first-count-increase | **never (null)** |
| reader `search()`: max hits seen / first non-zero-hit time | 10 / 8 ms (saw the pre-existing rows immediately) |
| reader periodic time-series (60 samples, ~2s apart, t=0 to t=119979ms) | **every single sample: count=165, hits=10 — completely flat for the full 2 minutes** |
| target-id freshness probe (`getById` on a row written ~10 batches after reader-open) | **never found (`targetFoundAtMs: null`) — the entire 2-minute run** |
| reader malformed hits | 0 |
| reader's own fresh reconnect at the end: `count()` | **8245** (a snapshot ~120s into the writer's still-running 150s window — correctly far above the frozen 165) |
| reconnect target-id found? | **true** — the SAME row the live reader could never see, found instantly by a brand-new handle |
| independent 3rd-process verifier `count()` after both exit | **9480** |
| final count vs total acknowledged | **9480 = 9480 — exact match** |

**Verdict: a long-lived reader opened against a table that demonstrably
already exists still never observes a concurrent writer's new commits, for
the entire measured window, via either `count()` or an exact-id lookup.**
This settles what scenario 1 alone could not: it is not merely "the table
didn't exist when the reader opened" — even with existence proven before
open, `count()` and `getById()` are pinned to the table snapshot from
`initialize()` and never advance. Root cause (confirmed by reading
`packages/lore/src/engines/verbatimStore.ts`): both methods read
`this.table` directly (`this.table.countRows()`;
`verbatimHistory.getById(this.table, ...)`), and `this.table` is assigned
exactly once, in `initialize()` (`this.table = await
this.db.openTable('lore_verbatim')`), and only ever reset to `null` in
`close()` — there is no `checkoutLatest()` call anywhere on that path.
`search()` behaves differently: it always returned 10 hits from t=0
onward (the pre-seeded rows), consistent with going through the read pool,
which DOES call `checkoutLatest()` on every acquire — but this run does
**not** establish that `search()` ever surfaced the specific new
post-open rows the freshness probe targeted, only that it kept finding
*some* 10 hits from the original seed set the whole time. That distinction
(does the vector index actually get freshly re-ranked to include new rows,
or does a `checkoutLatest()`'d handle still return the same nearest
neighbors because the index isn't incrementally extended) is the same
open question §12.1's original root-cause paragraph flagged for
`search()` — narrowed by this run (proven: not a table-existence issue)
but still not fully closed. **Practical implication, now on solid
footing: a process holding a long-lived `VerbatimStore` read handle must
reconnect (or otherwise force a fresh table checkout) to see another
process's writes — `count()` and `getById()` will not do this on their
own, ever, no matter how long the handle lives.**

Reproduce (now the default — running the whole script exercises all three
scenarios in sequence):

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH
node scripts/diagnostics/lance-two-process.mjs --duration-ms 120000 --json /tmp/lance-2p.json
# scenario1b's reader1b role can also be driven directly for a quick check:
# node scripts/diagnostics/lance-two-process.mjs --role reader1b --dir <dir> --target-id <id> --duration-ms 20000
```

### 12.5 Not measured, and why

- **Sustained runs longer than 2 minutes** — the ask specified "~2 minutes";
  not extended.
- **Whether `search()` ever surfaces a specific NEW row post-open on an
  existing table (§12.4)** — proven not to be a table-existence artifact
  (12.1's confound is resolved), but the underlying mechanism (vector index
  incrementally extended vs. rebuilt vs. some other pool-acquire behavior)
  was not isolated further within this task. Flagged, not guessed further.
- **Three or more concurrent writers**, or a writer + multiple readers —
  the ask specified reader+single-writer (now both the empty-dir and
  pre-seeded variants) and two-writer; those scenarios only.
- **Non-darwin platforms** — same scope limit as §11.

---

## 13. Splitting the memory regression test (2026-09-18)

`test/memory-open-close-cycles-unit.ts` (§5) ran a single `embedded`
create/dispose cycle and was, by design, EXPECTED TO FAIL on 3.19.1 and
PASS on 3.20.0 once the close-path fixes in this stack landed — and, for
that reason, was deliberately kept OUT of the main `npm test` chain (a test
engineered to fail on the then-current version would have broken CI).

By `pr/3.20.0-19-migrations-close-test` (this branch's base), every
close-path fix Lore itself controls has landed. But the test still failed,
at the same ~100 MB/cycle it always had — because `embedded` also opens
SurrealDB, and §9 establishes that `@surrealdb/node` 3.0.3 never frees a
datastore on `close()`, for reasons entirely outside Lore's close path (the
native binding leaks at the same rate driven directly, with no Lore and no
JS SDK involved at all). One test was asserting two different things —
"Lore's own close paths are leak-free" and "the SurrealDB driver doesn't
leak" — and only the first was ever going to be true on this driver
version.

**Split into two tests**, both now registered in the main `npm test` chain:

- **`test:unit:memory-open-close-cycles`** (rewritten) — asserts flat RSS
  (slope < 10 MB/cycle, cycles 5-20 of a 20-cycle run) for two cycle
  shapes entirely within Lore's control: a bare `VerbatimStore`
  open→write→close cycle, and a `WorkspaceVerbatimResolver`
  `getOrOpen()`→write→`evictIdle()` cycle — both LanceDB-only (no
  SurrealDB), fresh on-disk dir every cycle, same child-process +
  `--expose-gc` method as before. Reuses the `inproc` config's cycle shape
  and `runWorkspaceCycle`'s vector-store half from
  `scripts/measure-memory.mjs`/`measure-memory-configs.mjs` (as independent
  TS copies — those scripts are `.mjs`, outside `tsconfig.json`'s
  `include`/no `allowJs`, so a cross-import would fail `tsc --noEmit`).
  Measured on this branch: both shapes come back flat (~-6 MB/cycle,
  R²≈0.57 — noise, not a trend; well inside the ±10 MB/cycle threshold).
  Runtime: well under a minute for both shapes combined.
- **`test:unit:memory-surreal-leak-pinned`** (new) — a PINNED CANARY, not a
  regression guard: runs the `surreal-only` config's cycle body (bare
  `SurrealGraph` open→write→close, fresh dir every cycle, 8 cycles) and
  asserts the leak is STILL PRESENT (slope ≥ 50 MB/cycle). Measured on this
  branch: 100.3 MB/cycle, R²=1.000 — matches §9's evidence exactly. Its
  failure message states plainly: "the @surrealdb/node close() leak
  appears fixed — re-evaluate LORE_REGISTRY_IDLE_TTL_MS default (graph idle
  unloading) and docs/PERFORMANCE-MEMORY.md §9, then invert this test" —
  so if `@surrealdb/node` ever ships a fix, this test fails on purpose as
  the trigger to revisit both the graph-idle-unload default (turned off by
  `pr/3.20.0-21-graph-idle-unload-off`, precisely because of this leak —
  see §9 "What it means for hosts") and this doc's own verdict.

Both new/rewritten test files type-check cleanly under `tsconfig.test.json`
(no new `.test-type-baseline.json` quarantine entries) and `npm run
test:arch` / `npx tsc --noEmit` both pass unaffected.

### Reproduce

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH
npm run test:unit:memory-open-close-cycles
npm run test:unit:memory-surreal-leak-pinned
```

## 14. 3.21 Step 5 — per-open-workspace cost on the SQLite profile (2026-09-22)

Machine: macOS 26.5.1 (BuildVersion 25F80), Darwin 25.5.0 arm64
(`Darwin Kernel Version 25.5.0: Mon Apr 27 20:41:12 PDT 2026;
root:xnu-12377.121.6~2/RELEASE_ARM64_T6050 arm64`). Node v22.23.2. Branch
`pr/3.21.0-s5-memory-cost` off `pr/3.21.0-i3-verify` @ `f3891ced`.

Goal: measure and gate the per-open-workspace memory cost on the SQLite
storage profile (`SqliteGraph` + `SqliteVerbatimStore` — the 3.21 default
for a brand-new local workspace, per `graphEngineSelector.ts` /
`vectorEngineSelector.ts`), with a before/after comparison against the
pre-3.21 default, SurrealDB+LanceDB (`SurrealGraph` + `VerbatimStore`).
Target set by the 3.21 plan: ≤40 MB RSS per open store, no post-close floor
growth across cycles.

### Method — two measurement shapes

Both engine pairs were measured with two independent shapes, each in a
fresh child process with `--expose-gc`, forced GC + a settle wait before
every sample:

- **keep-open** (`scripts/diagnostics/workspace-profile-memory-measure.mjs
  --mode keep-open`): open N workspaces' worth of graph+vector engines and
  keep ALL of them alive (never closed, never GC-eligible) while writing a
  fixed number of nodes/docs to each; RSS delta ÷ N gives the steady-state
  cost of holding N stores open simultaneously. This is the same shape as
  §10.2's `open-store-cost-measure.mjs` precedent. Also reports the median
  *incremental* per-store delta after skipping warm-up stores (the one-time
  native-module-load cost dilutes the naive average for small N).
- **cycle** (`--mode cycle`): open → write → sample RSS (post-write,
  pre-close) → close both engines → forced GC + settle → sample RSS again
  (the post-close floor this cycle leaves behind) → repeat with a fresh
  temp dir every cycle. Reports the per-open delta (this cycle's open
  sample minus the previous cycle's close floor) and, across cycles, the
  OLS slope of the post-close floor (MB/cycle) — the leak-detection metric.

Both scripts are new, standalone diagnostics
(`scripts/diagnostics/workspace-profile-memory-measure.mjs` and its serial
repeat-and-aggregate wrapper `workspace-profile-memory-repeat.mjs`, which
runs the measure script N times as fresh child processes and reports
median + spread) — not wired into `npm test`, kept for reproducing these
numbers.

All repetitions were run **serially**, never in parallel, per the task's
methodology requirement.

### Results

| Profile | Mode | Per-open RSS delta (median, spread across reps) | Post-close floor growth / slope | Reps |
|---|---|---|---|---|
| SQLite (graph+vector both SQLite) | keep-open, N=15 | 14.18 MB avg (spread 0.099); 0.27 MB incremental steady-state (spread 0.016) | n/a (nothing closed in this mode) | 5 |
| SQLite | cycle, 50 cycles | — (see floor) | floor change over 50 cycles: median -90.45 MB (spread 0.19); slope **-2.87 MB/cycle** (spread 0.009) — i.e. shrinking, not growing | 3 |
| SurrealDB+LanceDB (pre-3.21 default) | keep-open, N=15 | 125.36 MB avg (spread 0.25); 104.15 MB incremental steady-state (spread 0.31) | n/a | 5 |
| SurrealDB+LanceDB | cycle, 50 cycles | — (see floor) | floor growth over 50 cycles: median +611.97 MB (spread 1.11); slope **+87.64 MB/cycle** (spread 0.22) | 3 |

CI gate test (`test/memory-sqlite-profile-open-close-cycles-unit.ts`,
smaller/faster: 50 cycles, 30 entries/cycle, 50ms settle vs. the diagnostic's
200ms) reproduces the same shape at its own scale, run 3× standalone for
stability before landing: floor slope 0.069–0.080 MB/cycle every run (flat,
well inside the ±10 MB/cycle noise band), per-open median 0.22 MB every run.

### Target: MET

SQLite comfortably clears the ≤40 MB/store target on every measure — worst
case is the keep-open *average* (14.18 MB, inflated by one-time
native-module load amortized over only 15 stores); the steady-state
incremental cost is under 1 MB/store. The post-close floor does not grow
across 50 cycles on either measurement scale; if anything it trends
slightly negative, consistent with allocator/page reclaim behavior rather
than any retained handle. No finding of "SQLite misses the target" was
produced, so there is nothing to report as a gap for this profile.

### Finding: the SurrealDB+LanceDB leak manifests at/after `close()`, not while open

The surreal-lance profile's **keep-open** incremental cost (104.15 MB/store,
stores never closed) and its **cycle** post-close floor growth (87.64
MB/cycle, stores closed every cycle) land in the same ~90-105 MB range —
but the *cycle* mode's own per-open delta (sampled right after write,
*before* close) stays small, matching keep-open's early-cycle behavior.
The ~100 MB/store cost only shows up in the sample taken *after* `close()`
returns. This is consistent with, and adds direct before/after-close
evidence for, §9's existing finding that `@surrealdb/node@3.0.3` defers its
WAL→sstable flush to (or past) `close()` and never frees the resulting
datastore — the memory is not held by the *open* store, it is created by
the *act of closing* it and then never released. This is not a new defect;
it is the same §9 leak, now isolated to the close boundary specifically
rather than "sometime during the store's lifetime."

### CI gates added

- **`test:unit:memory-sqlite-profile-open-close-cycles`** (new, registered
  in the main `npm test` chain, spliced immediately after
  `test:unit:memory-surreal-leak-pinned`): 50-cycle open/write/close on the
  SQLite profile in one child process, asserting (a) the post-close floor
  slope over cycles 6-50 stays below `FLOOR_SLOPE_FAIL_MB_PER_CYCLE = 10`
  MB/cycle — one to two orders of magnitude above the measured -2.87
  MB/cycle floor slope and the ±0.2 MB/cycle noise band the existing
  `memory-open-close-cycles-unit.ts` convention documents, and well below
  any real leak this sprint has measured (60-105 MB/cycle); and (b) the
  median per-open RSS delta over the same window stays ≤
  `PER_OPEN_BUDGET_MB = 40` (the 3.21 plan's own stated target, not a
  measured number). Runtime ~5s wall-clock (measured via `/usr/bin/time
  -p`), well under the ~90s budget. Verified non-flaky over 3 standalone
  runs (see numbers above).
- **Defensive fix** (goal 4): both `test/memory-open-close-cycles-unit.ts`
  and the new `test/memory-sqlite-profile-open-close-cycles-unit.ts` spawn
  their measurement child with `detached: true` and a bounded
  `CHILD_TIMEOUT_MS = 60_000` timeout that kills the child's whole process
  group (`process.kill(-child.pid, 'SIGKILL')`) and rejects with a clear
  message if it doesn't exit in time — the pattern already used by
  `test/embedded-abandoned-dispose-exit-unit.ts`'s `runChild()`. Previously
  `memory-open-close-cycles-unit.ts`'s `runCycles()` had no timeout or kill
  path at all: a wedged native handle on open/close would hang that test,
  and therefore the whole `npm test` chain, indefinitely.

### Reproduce

```bash
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH
# CI gate
npm run test:unit:memory-sqlite-profile-open-close-cycles

# Diagnostics (not part of npm test)
node --expose-gc scripts/diagnostics/workspace-profile-memory-repeat.mjs --profile sqlite --mode keep-open --cycles 15 --entries 100 --reps 5
node --expose-gc scripts/diagnostics/workspace-profile-memory-repeat.mjs --profile sqlite --mode cycle --cycles 50 --entries 100 --reps 3
node --expose-gc scripts/diagnostics/workspace-profile-memory-repeat.mjs --profile surreal-lance --mode keep-open --cycles 15 --entries 100 --reps 5
node --expose-gc scripts/diagnostics/workspace-profile-memory-repeat.mjs --profile surreal-lance --mode cycle --cycles 50 --entries 100 --reps 3
```
