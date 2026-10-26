/**
 * postgresPlanExecutor.ts - run a validated query plan on Postgres (Tables P3).
 *
 * One READ ONLY snapshot transaction per question (postgresReadOnlyTx.ts). The plan is validated INSIDE it, against
 * the catalogue that the SQL then runs on. Each data step (filter/join/aggregate) is counted with a bounded probe
 * (`LIMIT cap + 1`), so a cap is detected without scanning past it:
 *   - `rows_per_step`: a step would leave more than `maxRowsPerStep` rows;
 *   - `total_rows`: the rows left by all steps together exceed `maxTotalRows`.
 * A cap stops the question and the result names the cap and the step; rows are never silently truncated.
 * A step that leaves 0 rows stops the question with "step N left 0 rows" and the counts so far.
 */

import {
    type CapHit, type PlanError, type PlanLimits, type PlanResult, type ResultRow, type StepReport, type ValidOrderKey, type ValidPlan,
} from '../../query/planTypes.js';
import { validatePlan } from '../../query/planValidator.js';
import type { PostgresTableStorage } from './postgresTableStorage.js';
import { buildRelation, countQuery, resolveAsOf, rowsQuery } from './postgresPlanSql.js';
import type { PoolClient } from 'pg';
import type { TableMeta } from './postgresTableCatalog.js';
import { expandAliasPredicates } from './postgresPlanAlias.js';
import { flagUnreviewed } from './postgresPlanReview.js';
import { MixedCurrencyError } from './postgresTableErrors.js';
import { moneyStepChecks } from './postgresPlanMoney.js';

/** Map a driver failure to a typed plan error (no SQL text, no parameters). */
export function mapPlanError(e: unknown, step?: number): PlanError {
    const code = (e as { code?: string }).code;
    const message = e instanceof Error ? e.message : String(e);
    const at = step !== undefined ? { step } : {};
    if (e instanceof MixedCurrencyError) return { code: 'mixed_currency', message, column: e.column, currencies: e.currencies, ...at };
    if (code === '57014') return { code: 'statement_timeout', message: 'the query exceeded the statement timeout', ...at };
    if (code === '55P03') return { code: 'lock_timeout', message: 'the query could not get a lock in time', ...at };
    return { code: 'execution_failed', message, ...at };
}

export async function runPlanPostgres(storage: PostgresTableStorage, plan: unknown, limits: PlanLimits): Promise<PlanResult> {
    const workspace = storage.workspace;
    try {
        return await storage.runReadOnly(
            { statementTimeoutMs: limits.statementTimeoutMs, lockTimeoutMs: limits.lockTimeoutMs },
            async (client, tables) => {
                const v = validatePlan(plan, new Map([...tables].map(([name, m]) => [name, m.schema] as const)));
                if (!v.ok) return { status: 'invalid', errors: v.errors } as const;
                return runSteps(client, tables, v.plan, limits, workspace);
            });
    } catch (e) {
        return { status: 'error', error: mapPlanError(e) };
    }
}

async function runSteps(
    client: PoolClient, tables: ReadonlyMap<string, TableMeta>, plan: ValidPlan, limits: PlanLimits, workspace: string,
): Promise<PlanResult> {
    const aliased = await expandAliasPredicates(client, workspace, tables, plan.steps); // eq/in match aliases too
    const steps = aliased.steps;
    const now = limits.now ?? new Date();
    const cap = limits.maxRowsPerStep;
    const reports: StepReport[] = [];
    let asOf: string | null = null;
    let prev: number | null = null;
    let total = 0;
    let order: readonly ValidOrderKey[] | undefined;
    let limitN: number | undefined;
    const base = (): { label: 'exact'; workspace: string; asOf: string | null; steps: StepReport[] } => ({ label: 'exact', workspace, asOf, steps: reports });
    const capped = (cap: CapHit): PlanResult => ({ ...base(), status: 'capped', rows: [], rowCount: 0, cap });
    let current = 0;
    // Valid time covers the whole question: the LAST as_of step applies to every count and to the final rows.
    const lastAsOf = [...steps].reverse().find(x => x.op === 'as_of');
    const upTo = (k: number): ValidPlan['steps'] => [...(lastAsOf ? [lastAsOf] : []), ...steps.slice(0, k).filter(x => x.op !== 'as_of')];

    try {
        for (let i = 0; i < steps.length; i++) {
            const st = steps[i]!;
            current = i + 1;
            if (st.op === 'as_of') {
                asOf = resolveAsOf((lastAsOf as typeof st).date, now);
                reports.push({ step: current, op: st.op, label: 'exact', rows: prev, note: `valid time as of ${asOf} (applies to the whole question)` });
                continue;
            }
            if (st.op === 'order') { order = st.by; reports.push({ step: current, op: st.op, label: 'exact', rows: prev }); continue; }
            if (st.op === 'limit') {
                limitN = st.n;
                prev = prev === null ? null : Math.min(prev, st.n);
                reports.push({ step: current, op: st.op, label: 'exact', rows: prev });
                continue;
            }
            const money = await moneyStepChecks(client, upTo(i + 1), tables, now, i);
            if (money.invalid) return { status: 'invalid', errors: money.invalid };
            const q = countQuery(buildRelation(upTo(i + 1), tables, now), cap + 1);
            const n = Number(((await client.query(q.text, q.params)).rows[0] as { n: string }).n);
            if (n > cap) {
                reports.push({ step: current, op: st.op, label: 'exact', rows: null, note: `more than ${cap} rows` });
                return capped({ kind: 'rows_per_step', step: current, limit: cap, message: `step ${current} would leave more than ${cap} rows (per-step row cap)` });
            }
            total += n;
            reports.push({ step: current, op: st.op, label: 'exact', rows: n, ...money.report });
            if (total > limits.maxTotalRows) {
                return capped({ kind: 'total_rows', step: current, limit: limits.maxTotalRows, message: `the rows left by steps 1..${current} total ${total}, over the ${limits.maxTotalRows} total-rows cap` });
            }
            prev = n;
            if (n === 0) {
                for (let j = i + 1; j < steps.length; j++) {
                    reports.push({ step: j + 1, op: steps[j]!.op, label: 'exact', rows: 0, note: `not run: step ${current} left 0 rows` });
                }
                const counts = reports.filter(r => r.rows !== null && !r.note?.startsWith('not run')).map(r => `step ${r.step}: ${r.rows}`).join(', ');
                return { ...base(), status: 'empty', rows: [], rowCount: 0, emptyAt: { step: current, message: `step ${current} left 0 rows (${counts})` } };
            }
        }
        current = steps.length;
        const fq = rowsQuery(buildRelation(upTo(steps.length), tables, now), order, Math.min(limitN ?? cap, cap));
        const r = await client.query(fq.text, fq.params);
        const rows: ResultRow[] = (r.rows as Array<Record<string, unknown>>).map(row => {
            const values: Record<string, unknown> = {};
            fq.columns.forEach((c, idx) => { values[c.key] = c.decode(row[`c${idx}`]); });
            return { label: 'exact', values };
        });
        const review = await flagUnreviewed(client, workspace, tables, upTo(steps.length), now, rows, aliased.applied);
        return { ...base(), status: 'ok', columns: fq.columns.map(c => c.key), rows, rowCount: rows.length, ...review };
    } catch (e) {
        return { status: 'error', error: mapPlanError(e, current) };
    }
}
