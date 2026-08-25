# Storage diagnostics

Ad-hoc, read-only diagnostic and benchmark scripts for the storage layer.
Kept as standalone tools, not wired into any npm script or CI gate.

## History: the 2026-08-03 metadata-corruption investigation

The directory originally held a set of Kùzu-specific probes (`scan-*.mjs`,
`probe-v3-*.mjs`) written during the 2026-08-03 investigation into corrupted
`LoreNode.metadata` values.
The finding had a trivial signature — many rows sharing one byte-identical
large value — and was built into `lore check-corruption`
(`packages/lore/src/cli/commands/checkCorruption.ts`).

**Both the raw probe scripts and the `check-corruption` CLI command are now
deleted** (Kùzu removal, 2026-08-21 — the probes opened `.lore/graph` via
`kuzu.Database` directly and had no engine-agnostic equivalent; the CLI
command's worker entry point was Kùzu-only). If this class of corruption
needs investigating again on a SurrealDB-backed workspace, it needs a fresh
tool built against `SurrealGraph`/`surrealkv`, not a port of these — the
old probes' entire approach (direct native-driver opens, read-only-flag
discipline, single-id lookups to dodge a full-column-scan OOM) was Kùzu's
failure mode, not necessarily SurrealDB's.

## What is here now

| Script | What it does |
|---|---|
| `surreal-scale-parity.mjs` | SurrealDB load/RSS/latency benchmark at real scale (originally a Kùzu-vs-Surreal parity tool; Kùzu side removed 2026-08-21). |
| `surreal-backend-matrix.mjs` | Compares SurrealDB's embedded storage backends. |
| `wal-memory.ts` | WAL/checkpoint memory measurement. |
| `engine-workload-bench.ts` | Mixed-workload engine benchmark. |
| `summary-read-bench.ts` | Read-path summary benchmark. |
| `directed-traverse-bench.ts` | Directed-traversal benchmark. |

`migrate-workspace-to-surreal.mjs` (the one-time reference script for moving
a Kùzu-backed workspace to SurrealDB) is also deleted (2026-08-21) — its job
is done now that Kùzu support is fully removed and no workspace can declare
`graphEngine: 'kuzu'` to migrate away from.

None of these touch a real `LORE_HOME` unless explicitly pointed at one via
env vars — read each script's own header before running it against live data.
