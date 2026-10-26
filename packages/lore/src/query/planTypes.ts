/**
 * planTypes.ts - the closed query-plan grammar and the executor's result shapes (Tables P3).
 *
 * A plan is a small JSON document of typed steps from a CLOSED set. It carries NO workspace, NO SQL and
 * NO identifiers except names that must already exist in the workspace catalogue. The validator
 * (planValidator.ts) turns untrusted JSON into a `ValidPlan`; the executor only ever sees a `ValidPlan`.
 * Design: TABULAR-AND-COMBINED-QUERY-DESIGN-2026-10-23 sections 6.1, 6.3, 6.4, 7.
 */

import { MAX_JOIN_HOPS } from '../contracts/tables.js';

export const PLAN_VERSION = 1;
/** Step cap for one plan (design section 7). */
export const MAX_PLAN_STEPS = 12;
/** Join cap for one plan: the same bound as `joinMany` (contracts/tables.ts). */
export const MAX_PLAN_JOINS = MAX_JOIN_HOPS;
export const MAX_IN_VALUES = 100;
export const MAX_PREDICATES = 16;
export const MAX_GROUP_KEYS = 4;
export const MAX_MEASURES = 8;
export const MAX_HAVING = 4;
export const MAX_ORDER_KEYS = 4;
export const MAX_PLAN_LIMIT = 1_000_000;
export const MAX_VALUE_CHARS = 1000;

/** Steps that are part of the grammar but not executable yet; the validator answers `not_supported_yet`. */
export const DEFERRED_OPS = ['follow_link', 'semantic_search', 'judge'] as const;
export const EXECUTABLE_OPS = ['filter', 'join', 'aggregate', 'as_of', 'order', 'limit'] as const;

export type PredOp = 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'starts_with' | 'is_null' | 'not_null';
export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max';
export type HavingOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
export type ColumnKind = 'string' | 'integer' | 'float' | 'boolean' | 'date' | 'datetime' | 'json';

/** Bound-parameter value, already normalised for its column type. */
export type Bound = string | number | boolean | null;

export interface ColRef { alias: string; field: string }

/** A money literal: exact decimal string + upper-case ISO currency (never a JS number). */
export interface MoneyBound { amount: string; currency: string }

/** `bound` for plain columns and the `<money>__currency` pseudo-field; `money` for comparisons on a money column's amount. */
export interface ValidPredicate { field: string; op: PredOp; bound?: Bound | Bound[]; money?: MoneyBound | MoneyBound[] }
export interface ValidMeasure { fn: AggFn; as: string; ref?: ColRef }
/** A having threshold: a number for numeric measures, a `{ amount, currency }` for money measures. */
export type ValidHaving = { measure: string; op: HavingOp } & ({ value: number; money?: undefined } | { money: MoneyBound; value?: undefined });
export type ValidOrderKey = { dir: 'asc' | 'desc' } & ({ kind: 'column'; alias: string; field: string } | { kind: 'measure'; measure: string });

export type ValidStep =
    | { op: 'filter'; type?: string; alias: string; where: ValidPredicate[] }
    | { op: 'join'; type: string; alias: string; left: ColRef; rightField: string }
    | { op: 'aggregate'; groupBy: ColRef[]; measures: ValidMeasure[]; having: ValidHaving[] }
    | { op: 'as_of'; date: string }
    | { op: 'order'; by: ValidOrderKey[] }
    | { op: 'limit'; n: number };

export interface ValidPlan { steps: ValidStep[] }

export type IssueCode =
    | 'invalid_plan' | 'unknown_property' | 'workspace_not_allowed' | 'step_cap' | 'join_hop_cap' | 'unknown_step'
    | 'not_supported_yet' | 'unknown_type' | 'unknown_field' | 'unknown_alias' | 'duplicate_alias' | 'bad_value'
    | 'bad_operator' | 'type_mismatch' | 'bad_order' | 'no_source' | 'missing_property' | 'cap_exceeded';

export interface PlanIssue {
    code: IssueCode;
    /** 1-based step number, or null for plan-level issues. */
    step: number | null;
    /** JSON path inside the plan, e.g. `steps[2].where[0].field`. */
    path: string;
    message: string;
}

export type PlanValidation = { ok: true; plan: ValidPlan } | { ok: false; errors: PlanIssue[] };

/** Per-question limits chosen by the CALLER (never by the plan). */
export interface PlanLimits {
    /** Max rows any single step may leave (default 10,000). */
    maxRowsPerStep: number;
    /** Max rows summed over all steps of one question (default 50,000). */
    maxTotalRows: number;
    statementTimeoutMs: number;
    lockTimeoutMs: number;
    /** Clock for `as_of: "today"` (default: now). */
    now?: Date;
}

export const DEFAULT_PLAN_LIMITS: Readonly<PlanLimits> = {
    maxRowsPerStep: 10_000, maxTotalRows: 50_000, statementTimeoutMs: 15_000, lockTimeoutMs: 2_000,
};

export type CapKind = 'rows_per_step' | 'total_rows';
export interface CapHit { kind: CapKind; step: number; limit: number; message: string }

export interface StepReport {
    step: number;
    op: string;
    label: 'exact';
    /** Rows left after this step; null when the step has no relation yet (an `as_of` before the source) or the cap stopped it. */
    rows: number | null;
    note?: string;
    /** Filter step with a money comparison: rows that passed every other predicate but were left out because their
     *  currency differs from the literal's (additive; absent when the step has no money comparison). */
    excludedOtherCurrency?: number;
    /** Aggregate step with a money `having`: groups in another currency than the threshold that were not compared
     *  (only when the plan groups by `<column>__currency`; otherwise a currency mismatch is an `invalid` result). */
    excludedOtherCurrencyGroups?: number;
}

export interface ResultRow {
    label: 'exact';
    values: Record<string, unknown>;
    /** Set on Postgres plan results: true when a value this row rests on still needs review. Separate from `label`. */
    unreviewed?: boolean;
}

/** Postgres plan results: how much of the answer rests on unreviewed values (design 6.3). */
export interface ReviewHeader {
    /** The workspace's `reviewConfidenceThreshold` used for this answer. */
    threshold: number;
    unreviewedRows: number;
    totalRows: number;
}

/** A filter that matched aliases as well as the literal values (Postgres plans). */
export interface AliasApplied { step: number; alias: string; field: string; given: string[]; matched: string[] }

export interface PlanResultBase {
    label: 'exact';
    workspace: string;
    /** Resolved valid-time instant of the LAST `as_of` step (ISO), or null when the plan had none. */
    asOf: string | null;
    steps: StepReport[];
}

export type PlanResult =
    | (PlanResultBase & { status: 'ok'; columns: string[]; rows: ResultRow[]; rowCount: number; review?: ReviewHeader; aliasesApplied?: AliasApplied[] })
    | (PlanResultBase & { status: 'empty'; rows: []; rowCount: 0; emptyAt: { step: number; message: string } })
    | (PlanResultBase & { status: 'capped'; rows: []; rowCount: 0; cap: CapHit })
    | { status: 'invalid'; errors: PlanIssue[] }
    | { status: 'error'; error: PlanError };

export type PlanErrorCode =
    | 'engine_not_supported' | 'workspace_mismatch' | 'invalid_limits' | 'statement_timeout' | 'lock_timeout' | 'execution_failed'
    | 'mixed_currency';
/** `mixed_currency` is the table API's MixedCurrencyError code; `column` (`alias.field`) and `currencies` are set for it. */
export interface PlanError { code: PlanErrorCode; message: string; step?: number; column?: string; currencies?: string[] }

/** Mixed-currency rule (design Q9, Atlas decision "no mixed-currency sums"): `aggregate` sum/avg/min/max over money
 *  holding more than one currency (within a group, if grouped) returns the typed error `mixed_currency` instead of a number.
 *  A rate table would be the only way around it; none exists (extension point: planMoney.decideCurrencyCombination). */
export const MIXED_CURRENCY_RULE = 'refuse sum/avg/min/max across more than one currency (error code mixed_currency) until a rate table exists';
