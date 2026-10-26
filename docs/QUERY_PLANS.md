# Query plans (Tables P3)

A query plan is a small JSON document of typed steps that asks a question of the typed tables of one workspace. A
validator checks it against a closed grammar and the workspace catalogue; an executor runs it on Postgres with fixed
SQL templates. **No model is involved**: the same plan always gives the same answer, and every number is exact.

Status: library API only. There is no MCP tool, HTTP route or environment variable for it yet. Postgres table storage
only (server mode); any other engine answers `engine_not_supported`.

```ts
import { executePlan } from './packages/lore/src/query/executePlan.js';
const result = await executePlan(tableStorage, workspace, plan, { maxRowsPerStep: 10_000 });
```

`executePlan(storage, workspace, plan, limits?)` never throws for a bad plan, a cap, a timeout or an unsupported
engine; every outcome is a typed `PlanResult`. The `workspace` comes from the caller and must be the one the storage is
bound to (`workspace_mismatch` otherwise). **A plan cannot name a workspace**: `workspace`, `workspace_id`, `tenant`
and similar keys are refused with `workspace_not_allowed`.

## Grammar

```json
{ "version": 1, "steps": [
  { "op": "filter", "type": "cois", "where": [ { "field": "status", "op": "eq", "value": "active" } ] },
  { "op": "join", "type": "tenants", "on": { "left": { "alias": "cois", "field": "tenant_id" }, "right": { "field": "id" } } },
  { "op": "as_of", "date": "2026-03-01" },
  { "op": "aggregate", "group_by": [ { "alias": "tenants", "field": "region" } ],
    "measures": [ { "fn": "sum", "as": "total", "alias": "cois", "field": "premium" }, { "fn": "count", "as": "n" } ],
    "having": [ { "measure": "n", "op": "gte", "value": 2 } ] },
  { "op": "order", "by": [ { "measure": "total", "dir": "desc" } ] },
  { "op": "limit", "n": 10 } ] }
```

| Step | Meaning |
|---|---|
| `filter` | The first one names the source `type` (entity type = table name); later ones narrow an earlier alias. Predicates: `eq neq in gt gte lt lte contains starts_with is_null not_null`. `contains`/`starts_with` are case-insensitive and treat `%` and `_` literally. `gt..lte` work on string, integer, float, date, datetime. json columns support only the null checks. |
| `join` | Inner join of another type on `left.alias.field = right.field`. Both sides must be the same non-json type. Reserved columns (`_memory_node_id`, `_source_id`, ...) join like any other declared column. At most 4 joins (`MAX_JOIN_HOPS`). |
| `aggregate` | `group_by` (max 4), `measures` (max 8) of `count sum avg min max`, `having` (max 4) over numeric measures. Terminal: only `order` and `limit` may follow. |
| `as_of` | **Valid time** (half-open `[valid_from, valid_to)`, NULL = unbounded): `YYYY-MM-DD`, an ISO datetime, or `"today"`. Applies to the whole question wherever it sits (the last one wins). `"time": "recorded"` is `not_supported_yet`. |
| `order` | Columns, or (after an aggregate) group keys and measures. NULLs sort first on asc and last on desc. Ties break by group key or entity id, so output is deterministic. |
| `limit` | Final row count (1..1,000,000). It does not raise the per-step cap. |
| `follow_link`, `semantic_search`, `judge` | In the grammar, **refused with `not_supported_yet`**. |
| `money` columns | Supported in `filter`, `order` and `aggregate` (see "Money columns" below). Still **`not_supported_yet`**: using a money column as a `group_by` key (group by `<col>__currency` instead) or as a `join` key (join on an id column). |

Strict schema: unknown properties and unknown step ops are refused. Every type and field must exist in the workspace
catalogue. Aliases are plan-local labels (`[A-Za-z_][A-Za-z0-9_]*`); they never reach SQL. Step cap 12. Values are
coerced to the column type (an integer from `"42"` is fine; `"abc"` is `bad_value`). The validator returns **every**
reason (`code`, 1-based `step`, JSON `path`, `message`), not just the first.

## Execution and safety

- Fixed SQL templates only. Identifiers (view and column names) come from the catalogue and are quoted; the SQL aliases
  are generated (`j0`, `j1`...); operators, functions and directions come from closed tables; **every value is a bound
  parameter** with an explicit cast.
- The workspace id is baked into the per-type read view; the caller's workspace is the only one a plan can reach.
- One `READ ONLY`, `REPEATABLE READ` transaction per question, always rolled back. A write inside it fails with SQLSTATE
  25006. `statement_timeout` and `lock_timeout` are set `LOCAL` (they do not leak to the pool); a timeout is returned as
  `statement_timeout` / `lock_timeout` with the step. The plan is validated against the catalogue read inside the same
  transaction, so validation and SQL see one snapshot.
- Caps (`PlanLimits`, chosen by the caller, defaults `maxRowsPerStep` 10,000, `maxTotalRows` 50,000,
  `statementTimeoutMs` 15,000, `lockTimeoutMs` 2,000). Each data step is counted with a bounded probe
  (`LIMIT cap + 1`), so a cap is detected without scanning past it. A cap stops the question and the result names the
  cap and the step (`status: "capped"`, `cap: { kind, step, limit, message }`). **Rows are never silently truncated.**

## Result

`status` is one of:

- `ok` - `columns`, `rows` (each `{ label: "exact", values }`), `rowCount`, `steps` (per-step `{ step, op, rows,
  label: "exact" }`), `asOf` (the resolved instant or null).
  On Postgres, `ok` also carries `review` (`{ threshold, unreviewedRows, totalRows }`), each row an additive
  `unreviewed` boolean (the `label` stays `exact`), and `aliasesApplied` when an `eq`/`in` filter was widened by the
  workspace alias table. See the review queue section of [CONFIGURATION.md](CONFIGURATION.md).
- `empty` - a step left 0 rows. `emptyAt.message` reads "step 2 left 0 rows (step 1: 4, step 2: 0)"; later steps are
  listed as "not run".
- `capped` - see above.
- `invalid` - `errors[]` from the validator; nothing ran.
- `error` - `{ code, message, step? }` with code `engine_not_supported`, `workspace_mismatch`, `invalid_limits`, `mixed_currency`,
  `statement_timeout`, `lock_timeout` or `execution_failed`.

Output columns are `alias.field` for plain rows (plus `alias._entity_id`, `alias._memory_node_id`, `alias._source_id`),
or group keys (`alias.field`) and measure names after an aggregate. `count` is an exact integer; `sum`/`avg` come back
as a number when exactly representable, otherwise as a decimal string (no float rounding of money).

## Money columns (currency-aware)

A money column is stored as an exact decimal amount plus a 3-letter currency. A plan sees two things per money column
`price`: the column itself (`{ "amount": "1234.50", "currency": "USD" }` in results) and the pseudo-field `price__currency`
(a string, usable in `filter` with `eq neq in`, as a `group_by` key, with `count`, and in `order`).

- **Filter.** A money value MUST carry its currency: `{ "field": "price", "op": "gt", "value": { "amount": "1000.00", "currency": "USD" } }`.
  The amount is a decimal **string** (a JSON number or a missing currency is a validation error naming the step and
  path - the design is silent here, so this is the rule: a threshold must never silently mix currencies). Operators:
  `eq neq in gt gte lt lte is_null not_null`. A comparison only holds within the literal's currency, `neq` included:
  `price neq USD 5.00` means "in USD and not 5.00". Rows in other currencies are left out, never compared, and the
  step report says how many: `steps[i].excludedOtherCurrency` (additive field, only on filter steps with a money
  comparison; rows with no amount are not counted). To match several currencies, filter `price__currency in [..]`.
- **Order.** By currency first (ascending, whatever the direction), then by amount in the requested direction, so
  amounts of different currencies are never ranked against each other. An aggregated money measure orders the same way.
- **Aggregate.** `sum min max avg` over a money column return `{ amount, currency }` (exact decimal string; avg keeps
  Postgres's full numeric scale); `count` returns an integer and never needs one currency. Group by `<col>__currency`
  to get one result per currency.
- **Mixed currencies are refused.** If `sum/min/max/avg` would combine more than one currency (within a group, when
  grouped), the result is `status: "error"` with `error: { code: "mixed_currency", step, column, currencies, message }`
  - the same code the table API raises (`MixedCurrencyError`). `having` and `limit` never hide a mixed group: the check
  runs on every group first. Fix it by filtering to one currency or grouping by `<col>__currency`.
- **Having.** A threshold on a money measure must be `{ amount, currency }`. If the plan already pins the column to
  another currency (an earlier `filter` with `price__currency eq` or a money comparison on the same alias), validation
  fails with `type_mismatch` at `$.steps[n].having[k].value.currency`. If groups are in a currency other than the
  threshold's: when the plan groups by `<col>__currency` those groups are skipped and counted in
  `steps[i].excludedOtherCurrencyGroups`; otherwise the result is `invalid`, naming the step.
- **No rate table.** There is no exchange-rate feature, so mixed sums stay refused. The single place that would decide
  otherwise is `decideCurrencyCombination` in `packages/lore/src/query/planMoney.ts`; today it always throws
  `MixedCurrencyError`. A future rate-table feature changes only that function.

Amounts are never parsed to JS numbers: they are bound as `numeric` and returned as text.

## Tests

`test:unit:query-plan-validator` (pure), `test:unit:pg-query-plan` and `test:unit:pg-query-plan-money` (need `LORE_PG_URL`;
skip cleanly without it).
