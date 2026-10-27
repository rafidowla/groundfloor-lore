/**
 * postgresBackupJobIds.ts — re-mint ingestion job ids when a bundle is restored into a DIFFERENT workspace.
 *
 * WHY: `lore_ingest_jobs.job_id` is a global PRIMARY KEY (and `lore_ingest_pending.job_id` /
 * `lore_ingest_deliveries.job_id` are keyed on it too), not scoped by `workspace_id`. Rows restored into a new
 * workspace while the source still exists would carry the source's job ids and collide on `lore_ingest_jobs_pkey`.
 * Job ids are derived (`makeJobId`: sha256 over the workspace key, source id, stage, processor, contract version,
 * parent job id and params), so the restore derives them again for the target workspace exactly as a native
 * `createJob` there would. That keeps resubmission idempotent: an identical upload + job in the restored workspace
 * finds the restored job (`created = false`) instead of creating a second one.
 *
 * REFERENCES HANDLED (all of them live in the bundle's own rows, so the rewrite is closed over the bundle):
 *   - lore_ingest_jobs.job_id, lore_ingest_jobs.parent_job_id (parents are re-minted first; the parent id is a hash input)
 *   - lore_ingest_pending.job_id, lore_ingest_deliveries.job_id
 * LEFT AS-IS (informational echoes, never used as a key or compared with the row's own id): `result` / `payload` JSONB
 * `jobId`, graph-node `metadata.ingestion.jobId`, structured-table `_job_id`. Memory node ids and `_row_id` derive from
 * the OLD job id and are restored verbatim, so already-written content stays addressable; only a job that is re-run in
 * the target (retry / dead-letter requeue) writes under the new id.
 *
 * Not applied when the target is the bundle's own workspace id (disaster recovery keeps ids byte for byte).
 * The manifest checksums are over the ORIGINAL rows, so read-back verification maps new ids back before comparing.
 */

import { createHash } from 'node:crypto';
import { bundleRows, type BundleHeader } from './postgresBackupBundle.js';
import { INGEST_TABLES } from './postgresIngestionSchema.js';
import { LogicalBackupError, SCHEMA_MISMATCH } from '../workspaceLogicalBackup.js';
import { makeJobId, type JobStage } from '../../ingestion/store.js';

export interface JobIdRewrite {
    /** Number of job ids re-minted. */
    readonly count: number;
    /** Bundle row values -> values to insert into the target workspace. Returns the input when the table is untouched. */
    forward(table: number, values: (string | null)[]): (string | null)[];
    /** Values read back from the target -> the bundle's original values (for checksum verification). */
    reverse(table: number, values: (string | null)[]): (string | null)[];
}

/** Columns that hold a job id, per ingestion table. */
const JOB_ID_COLUMNS: Record<string, string[]> = {
    [INGEST_TABLES.jobs]: ['job_id', 'parent_job_id'],
    [INGEST_TABLES.pending]: ['job_id'],
    [INGEST_TABLES.deliveries]: ['job_id'],
};
const JOB_HASH_COLUMNS = ['job_id', 'source_id', 'stage', 'processor_id', 'contract_version', 'parent_job_id', 'params'] as const;

interface JobSeed { source: string; stage: string; processor: string; contract: string; parent: string | null; params: string }

/** Plan the rewrite, or null when nothing needs it (same workspace, or the bundle holds no ingestion jobs). */
export async function planJobIdRewrite(bundlePath: string, header: BundleHeader, targetKey: string): Promise<JobIdRewrite | null> {
    if (header.sourceWorkspaceId === targetKey) return null;
    const jobsIdx = header.tables.findIndex((t) => t.name === INGEST_TABLES.jobs);
    if (jobsIdx < 0) return null;

    // Any other ingestion table that carries a job id column must be listed above, or its ids would be restored stale.
    const positions = new Map<number, number[]>();
    for (let i = 0; i < header.tables.length; i++) {
        const t = header.tables[i]!;
        const wanted = JOB_ID_COLUMNS[t.name];
        const idCols = t.columns.map((c, j) => [c.name, j] as const).filter(([n]) => /(^|_)job_id$/.test(n));
        if (!wanted) {
            if (t.name.startsWith('lore_ingest_') && idCols.length > 0) {
                throw new LogicalBackupError(SCHEMA_MISMATCH, `restore into another workspace cannot re-mint job ids held by ${t.name}.${idCols[0]![0]} (unknown ingestion table); nothing was written`);
            }
            continue;
        }
        const idx = wanted.map((n) => t.columns.findIndex((c) => c.name === n)).filter((j) => j >= 0);
        if (idx.length > 0) positions.set(i, idx);
    }
    const jobs = header.tables[jobsIdx]!;
    const at = Object.fromEntries(JOB_HASH_COLUMNS.map((n) => [n, jobs.columns.findIndex((c) => c.name === n)])) as Record<(typeof JOB_HASH_COLUMNS)[number], number>;
    const missing = JOB_HASH_COLUMNS.filter((n) => at[n] < 0 && n !== 'parent_job_id');
    if (missing.length > 0) {
        throw new LogicalBackupError(SCHEMA_MISMATCH, `bundle's ${jobs.name} lacks column(s) ${missing.join(', ')}; cannot re-mint job ids; nothing was written`);
    }

    const seeds = new Map<string, JobSeed>();
    for await (const row of bundleRows(bundlePath)) {
        if (row.table !== jobsIdx) continue;
        const v = row.values;
        seeds.set(v[at.job_id]!, {
            source: v[at.source_id]!, stage: v[at.stage]!, processor: v[at.processor_id]!, contract: v[at.contract_version]!,
            parent: at.parent_job_id >= 0 ? v[at.parent_job_id] ?? null : null, params: v[at.params] ?? '{}',
        });
    }

    const forward = new Map<string, string>();
    const taken = new Set<string>();
    const resolve = (oldId: string, visiting: Set<string>): string => {
        const done = forward.get(oldId);
        if (done !== undefined) return done;
        const s = seeds.get(oldId)!;
        if (visiting.has(oldId)) throw new LogicalBackupError(SCHEMA_MISMATCH, `ingestion job ${oldId} is its own ancestor (parent_job_id cycle); nothing was written`);
        visiting.add(oldId);
        const parent = s.parent === null ? null : seeds.has(s.parent) ? resolve(s.parent, visiting) : s.parent;
        visiting.delete(oldId);
        let id = makeJobId({
            workspace: targetKey, sourceId: s.source, stage: s.stage as JobStage, processorId: s.processor, contractVersion: s.contract,
            parentJobId: parent, params: JSON.parse(s.params) as Record<string, unknown>,
        });
        // Two old ids that hash to the same new id (a legacy name-hashed row beside a key-hashed twin): keep both rows.
        if (taken.has(id)) id = 'job_' + createHash('sha256').update(`${targetKey}\0${oldId}`).digest('hex').slice(0, 32);
        taken.add(id);
        forward.set(oldId, id);
        return id;
    };
    for (const oldId of seeds.keys()) resolve(oldId, new Set());

    const reverseMap = new Map([...forward].map(([o, n]) => [n, o] as const));
    const rewrite = (map: Map<string, string>) => (table: number, values: (string | null)[]): (string | null)[] => {
        const cols = positions.get(table);
        if (!cols) return values;
        const out = values.slice();
        for (const j of cols) {
            const v = out[j];
            if (v !== null && v !== undefined) { const m = map.get(v); if (m !== undefined) out[j] = m; }
        }
        return out;
    };
    return { count: forward.size, forward: rewrite(forward), reverse: rewrite(reverseMap) };
}
