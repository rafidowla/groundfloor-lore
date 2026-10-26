# Follow-up: link rebuild stalls the event loop on SQLite

Status: open, investigation only. No code change is proposed here.

## What is known

- On a workspace using the SQLite graph engine, each link-rebuild batch (`LinkRebuilder`, default 50 nodes) blocks the event loop for roughly 2 to 4.5 seconds. The cost is compute-bound kNN over the vectors, run synchronously on the main thread.
- Because the batch is compute-bound, the pause between batches barely changes throughput: 10 ms versus 200 ms moved the rebuild by about 5% (see CHANGELOG, link-rebuild bench note).
- The mitigation shipped alongside this note only changes the gap between stalls: the idle pause defaults to 200 ms on SQLite (10 ms on Postgres), so other requests get a window between batches. It does not shorten a stall. A request that arrives mid-batch still waits the full 2 to 4.5 s.
- Postgres batches mostly wait on the database, so they do not stall the loop the same way.

## Options to investigate

1. Smaller batches on SQLite. `LORE_LINK_REBUILD_BATCH_SIZE` already exists (default 50, range 1 to 1000). A per-engine default of 10 to 15 would cut each stall roughly proportionally. Questions: the per-batch fixed cost (prefetch, cursor write, diff window) and whether total rebuild time grows; the interaction with `reusedComputes` and the prefetch window.
2. Move the batch compute onto the existing worker isolation. The opt-in search-worker isolation (see the 2026-07 SearchGate work) already runs queries off the main thread. Questions: whether the kNN and diff step can run there without shipping the vectors on every batch (the cost of structured-cloning 50 nodes of vectors versus the compute saved), who owns the SQLite handle, and how a cancel or a stop mid-batch is honoured.
3. Yield inside a batch. Split the per-node loop so it awaits `setImmediate` (or a short sleep) every few nodes. Smallest change and keeps one process. Questions: whether the substrate calls are synchronous native calls that cannot be interrupted at all, and whether the cursor and edge-write atomicity assumptions survive a yield mid-batch.

## How to measure

- Event-loop delay (`perf_hooks.monitorEventLoopDelay`) while a rebuild runs on a 50k-node SQLite workspace, with a concurrent recall loop; report p50, p99 and max recall latency, and rebuild nodes per second.
- Compare the three options against the current baseline and against batch size 50 with the 200 ms pause.
- Gate: no regression of the link-rebuild parity suite (`test:unit:link-rebuild-parity`), which proves a rebuild yields the same edges as a legacy run.

## Not in scope

- Changing the link algorithm, the policy or the thresholds.
- Postgres behaviour.
