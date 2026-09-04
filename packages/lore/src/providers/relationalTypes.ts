/**
 * relationalTypes.ts — the RELATIONAL substrate seam.
 *
 * Lore's local engine is tri-substrate: graph (SurrealDB), vector (LanceDB),
 * and relational (SQLite). This file declares the swap point for the
 * *relational* substrate — the outbox / migrations / audit / load-jobs /
 * tabular-collections store — so that an embeddable build can choose its
 * relational backend the same way it chooses graph and vector backends.
 *
 * ──────────────────────────────────────────────────────────────────────
 * NATIVE-DEPENDENCY EMBEDDING CONSTRAINT (read before bundling Lore Core)
 * ──────────────────────────────────────────────────────────────────────
 *
 * Lore Core's three substrates are each backed by a native addon that
 * ships a precompiled `.node` binary:
 *
 *   • Relational → `better-sqlite3`     (this seam)
 *   • Graph      → `@surrealdb/node`
 *   • Vector     → `@lancedb/lancedb`
 *
 * Those `.node` binaries are **ABI-locked**: a binary compiled against
 * one Node.js ABI (NODE_MODULE_VERSION / the host's V8) will refuse to
 * load — or crash — under a different ABI. They therefore **cannot be
 * bundled** into a portable artifact (no esbuild/webpack inlining, no
 * single-file pkg/nexe, no "copy the .node into the tarball"). Doing so
 * pins consumers to one exact Node build and breaks on every other.
 *
 * The contract for any host embedding Lore Core is instead:
 *
 *   The host MUST `npm install` these native deps against ITS OWN Node
 *   ABI at install time, so each addon is (re)compiled / fetches the
 *   prebuilt matching the host runtime. Lore Core declares them as real
 *   dependencies and never tries to inline their binaries.
 *
 * This seam exists so the relational substrate can be swapped for a
 * non-native (or differently-native) implementation when a host cannot
 * supply better-sqlite3 — without that host having to fork the engine.
 *
 * ──────────────────────────────────────────────────────────────────────
 * CLOUD RELATIONAL ADAPTER IS OUT OF SCOPE HERE — DELEGATED TO DATAPLANE
 * ──────────────────────────────────────────────────────────────────────
 *
 * This file is the LOCAL relational typing only. The *cloud* relational
 * adapter (Postgres-backed, behind the unified storage contract) is
 * owned by Dataplane and reached via `groundfloor-ts-sdk` — never by
 * importing `pg` (or any cloud DB driver) into Lore Core (arch rule
 * D-017). Cloud mode stays a first-class, switchable backend; nothing
 * in this seam deletes, stubs, or bypasses the DataplaneGraph /
 * DataplaneVectorStore adapters or cloud selectability. The
 * `RelationalProvider` interface below describes the *embeddable / local*
 * contract that `SqliteTableStorage` satisfies today; the cloud sibling
 * implements the same row/table surface server-side.
 */

import type {
    BackendCapabilities,
    EvolutionStep,
    ITableStorage,
    JoinSpec,
    Row,
    TableSchema,
} from '../contracts/tables.js';

/**
 * Re-export the canonical tabular surface so callers can depend on this
 * relational seam without reaching across into `../contracts/tables.js`.
 * `RelationalProvider` is intentionally built ON TOP of `ITableStorage`
 * (it does not duplicate-and-diverge) — the row/table/query surface is
 * the same contract the rest of the engine already programs against.
 */
export type {
    BackendCapabilities,
    ColumnDecl,
    ColumnType,
    EvolutionStep,
    ITableStorage,
    JoinSpec,
    Row,
    TableSchema,
} from '../contracts/tables.js';

/**
 * RelationalProvider — the embeddable relational-substrate contract.
 *
 * A `RelationalProvider` IS an `ITableStorage` (the universal tabular
 * surface: createTable / insert / query / update / delete / count /
 * truncate, plus the optional `join` and `evolveSchema`) extended with
 * the substrate-lifecycle method a host needs to manage a relational
 * backend it owns the handle to.
 *
 * `SqliteTableStorage` is the reference implementation and satisfies
 * this interface as-is. A future non-native or cloud-delegating
 * relational provider implements the same surface so the engine's
 * outbox / migrations / audit / tabular-collections code is backend
 * agnostic.
 */
export interface RelationalProvider extends ITableStorage {
    /**
     * Release the underlying relational handle (file descriptor, native
     * DB connection, pool). MUST be idempotent — calling `close()` on an
     * already-closed provider is a no-op, never an error. Hosts call this
     * on workspace teardown / daemon shutdown.
     */
    close(): void;
}

// Keep the type-only imports referenced so `isolatedModules` / lint do
// not flag them as unused; this also documents the surface a provider
// must implement at a glance.
export type RelationalRow = Row;
export type RelationalSchema = TableSchema;
export type RelationalJoinSpec = JoinSpec;
export type RelationalEvolutionStep = EvolutionStep;
export type RelationalCapabilities = BackendCapabilities;
