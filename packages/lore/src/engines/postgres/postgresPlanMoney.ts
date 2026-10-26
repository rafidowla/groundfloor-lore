/**
 * postgresPlanMoney.ts - the extra statements a query-plan step needs when it touches money (Tables P3, currency-aware).
 *
 * The executor calls `moneyStepChecks` once per data step, BEFORE the step is counted:
 *   - filter step with a money comparison: counts the rows that passed every other predicate but sit in another currency
 *     than the literal (`excludedOtherCurrency`) - they are left out, never compared, and the report says how many;
 *   - aggregate step with sum/avg/min/max over money: if any group (the whole set when ungrouped) holds more than one
 *     currency, throws the table API's MixedCurrencyError (through `decideCurrencyCombination`, the single place that
 *     would consult a rate table). HAVING never hides a mixed group: the check ignores it;
 *   - aggregate step with a money `having`: a group whose currency differs from the threshold's is either not compared
 *     (the plan groups by `<column>__currency`; counted in `excludedOtherCurrencyGroups`) or, when the plan does not
 *     group by currency, an `invalid` result naming the step.
 * Amounts stay exact: they are compared as numeric and never parsed to a JS number.
 */

import type { PoolClient } from 'pg';

import type { PlanIssue, StepReport, ValidStep } from '../../query/planTypes.js';
import { decideCurrencyCombination } from '../../query/planMoney.js';
import type { TableMeta } from './postgresTableCatalog.js';
import { buildRelation, groupBySql, whereSql, type Relation } from './postgresPlanSql.js';
import { CURRENCY_SUFFIX } from './postgresTableSchema.js';
import { qi } from './postgresTableViews.js';

export type MoneyStepOutcome =
    | { invalid: PlanIssue[] }
    | { invalid?: undefined; report: Partial<Pick<StepReport, 'excludedOtherCurrency' | 'excludedOtherCurrencyGroups'>> };

const NONE: MoneyStepOutcome = { report: {} };

/**
 * `upTo` is the step list the executor builds for this step (the last element is the step itself); `index` is the
 * 0-based position of the step in the validated plan (for issue paths).
 */
export async function moneyStepChecks(
    client: PoolClient, upTo: readonly ValidStep[], tables: ReadonlyMap<string, TableMeta>, now: Date, index: number,
): Promise<MoneyStepOutcome> {
    const last = upTo[upTo.length - 1];
    if (last?.op === 'filter') return filterExcluded(client, upTo, last, tables, now);
    if (last?.op === 'aggregate') return aggregateChecks(client, upTo, last, tables, now, index);
    return NONE;
}

async function filterExcluded(
    client: PoolClient, upTo: readonly ValidStep[], last: Extract<ValidStep, { op: 'filter' }>, tables: ReadonlyMap<string, TableMeta>, now: Date,
): Promise<MoneyStepOutcome> {
    const moneyPreds = last.where.filter(p => p.money !== undefined && p.op !== 'is_null' && p.op !== 'not_null');
    if (moneyPreds.length === 0) return NONE;
    // Same relation with this step's money comparisons removed, then count the rows whose currency fails any of them.
    const stripped: ValidStep = { ...last, where: last.where.filter(p => !moneyPreds.includes(p)) };
    const r = buildRelation([...upTo.slice(0, -1), stripped], tables, now);
    const src = r.srcs.find(s => s.alias === last.alias)!;
    const mismatch = moneyPreds.map(p => {
        const cur = r.params.add([...new Set((Array.isArray(p.money) ? p.money : [p.money!]).map(m => m.currency))], 'text[]');
        const c = `${src.sql}.${qi(p.field + CURRENCY_SUFFIX)}`;
        return `(${src.sql}.${qi(p.field)} IS NOT NULL AND ${c}::text <> ALL(${cur}))`;
    });
    const where = [...r.where, `(${mismatch.join(' OR ')})`];
    const q = `SELECT count(*)::text AS n FROM ${r.from} WHERE ${where.join(' AND ')}`;
    const n = Number(((await client.query(q, r.params.values)).rows[0] as { n: string }).n);
    return { report: { excludedOtherCurrency: n } };
}

async function aggregateChecks(
    client: PoolClient, upTo: readonly ValidStep[], last: Extract<ValidStep, { op: 'aggregate' }>, tables: ReadonlyMap<string, TableMeta>, now: Date, index: number,
): Promise<MoneyStepOutcome> {
    // HAVING is deliberately left out of the relation: its bound values would be unused parameters here, and the checks
    // below must see every group, including the ones HAVING would drop.
    const r: Relation = buildRelation([...upTo.slice(0, -1), { ...last, having: [] }], tables, now);
    const measures = (r.agg?.measures ?? []).filter(m => m.money);
    if (measures.length === 0) return NONE;
    const from = `FROM ${r.from}${whereSql(r)}${groupBySql(r)}`;

    // 1. Mixed currencies inside a group (HAVING is deliberately not applied).
    const seen = new Set<string>();
    for (const me of measures) {
        const mm = me.money!;
        if (seen.has(mm.key)) continue;
        seen.add(mm.key);
        const q = `SELECT cs FROM (SELECT array_agg(DISTINCT ${mm.cur}::text ORDER BY ${mm.cur}::text) FILTER (WHERE ${mm.col} IS NOT NULL) AS cs ${from}) s ` +
            'WHERE cardinality(cs) > 1 LIMIT 1';
        const row = (await client.query(q, r.params.values)).rows[0] as { cs: string[] } | undefined;
        if (row) decideCurrencyCombination(mm.key, row.cs);
    }

    // 2. A money threshold must be in the group's currency.
    let groupsExcluded: number | undefined;
    for (let j = 0; j < last.having.length; j++) {
        const h = last.having[j]!;
        const me = measures.find(m => m.m.as === h.measure);
        if (h.money === undefined || !me) continue;
        const mm = me.money!;
        const p = r.params.add(h.money.currency, 'text');
        const q = `SELECT count(*)::text AS n FROM (SELECT ${mm.curAgg} AS c ${from}) s WHERE c IS NOT NULL AND c <> ${p}`;
        const n = Number(((await client.query(q, r.params.values)).rows[0] as { n: string }).n);
        if (n === 0) continue;
        if (!mm.groupedByCurrency) {
            return { invalid: [{
                code: 'type_mismatch', step: index + 1, path: `$.steps[${index}].having[${j}].value.currency`,
                message: `having threshold on '${h.measure}' is in ${h.money.currency} but ${n} group(s) are in another currency; ` +
                    `group by '${mm.key}${CURRENCY_SUFFIX}' to compare each currency on its own`,
            }] };
        }
        groupsExcluded = Math.max(groupsExcluded ?? 0, n);
    }
    return { report: groupsExcluded !== undefined ? { excludedOtherCurrencyGroups: groupsExcluded } : {} };
}
