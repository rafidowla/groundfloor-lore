/**
 * postgresLockFreeDdl.ts — make the steady-state schema bootstrap take no table locks.
 *
 * Every open replays the idempotent schema DDL (`CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT
 * EXISTS`). Postgres takes the statement's table lock BEFORE it checks "if not exists": `CREATE INDEX IF NOT EXISTS`
 * on an existing index still waits for SHARE, and `ADD COLUMN IF NOT EXISTS` on existing columns still waits for
 * ACCESS EXCLUSIVE. While a background `CREATE INDEX CONCURRENTLY` runs on the same table (keyword, workspace-sk,
 * created_at_ts builds on a large table), such a no-op statement queues behind the build's SHARE UPDATE EXCLUSIVE
 * lock, and the build in turn waits for the statement's transaction to end: deadlock (40P01), and the open fails.
 * A second handle opened by the same process (or another process opening the same database) hits exactly that.
 *
 * {@link lockFreeDdlClient} wraps the bootstrap client. For a plain-text query made only of statements it
 * recognizes, it runs them one by one and skips every statement whose object already exists, using catalog
 * reads (no table lock):
 *
 *   - `CREATE TABLE IF NOT EXISTS t (...)`                       skipped when `t` exists
 *   - `CREATE [UNIQUE] INDEX [CONCURRENTLY] IF NOT EXISTS i ON t` skipped when a relation `i` exists in `t`'s schema
 *   - `ALTER TABLE t ADD [COLUMN] IF NOT EXISTS c ...[, ...]`    skipped when every named column exists
 *
 * Anything else (a parameterized query, a DO block, a mix with an unrecognized statement) passes through
 * unchanged, so the wrapper can only remove no-op statements, never change what a real one does. When an
 * object is missing the original statement runs as written, with its own IF NOT EXISTS.
 *
 * Note: a multi-statement string now runs as separate autocommitted statements instead of one implicit
 * transaction. Every bootstrap statement is idempotent and the bootstrap is already statement-by-statement
 * (postgresStartup.ts), so that is the intended shape, and it stops one string from accumulating locks.
 */

import type { PoolClient, QueryResult } from 'pg';

type Q = Pick<PoolClient, 'query'>;

/** One recognized statement and how to tell it is already done. */
export type GuardedStatement =
    | { kind: 'table'; sql: string; table: string }
    | { kind: 'index'; sql: string; table: string; index: string }
    | { kind: 'columns'; sql: string; table: string; columns: string[] };

/**
 * Split SQL text on top-level `;`, respecting '...' and "..." quotes, $tag$...$tag$ bodies, `--` line comments
 * and `/* *\/` block comments. Comments are dropped from the returned statements; empty statements are omitted.
 */
export function splitSqlStatements(text: string): string[] {
    const out: string[] = [];
    let cur = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i]!;
        const next = text[i + 1];
        if (ch === '-' && next === '-') {
            const end = text.indexOf('\n', i);
            i = end === -1 ? n : end;
            cur += ' ';
            continue;
        }
        if (ch === '/' && next === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? n : end + 2;
            cur += ' ';
            continue;
        }
        if (ch === '\'' || ch === '"') {
            let j = i + 1;
            for (; j < n; j++) {
                if (text[j] === ch) {
                    if (text[j + 1] === ch) { j++; continue; } // doubled quote
                    break;
                }
            }
            cur += text.slice(i, j + 1);
            i = j + 1;
            continue;
        }
        if (ch === '$') {
            const m = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(text.slice(i));
            if (m) {
                const tag = m[0];
                const end = text.indexOf(tag, i + tag.length);
                const stop = end === -1 ? n : end + tag.length;
                cur += text.slice(i, stop);
                i = stop;
                continue;
            }
        }
        if (ch === ';') {
            if (cur.trim() !== '') out.push(cur.trim());
            cur = '';
            i++;
            continue;
        }
        cur += ch;
        i++;
    }
    if (cur.trim() !== '') out.push(cur.trim());
    return out;
}

/** Split on top-level commas (outside parentheses and quotes). */
function splitTopLevelCommas(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    let quote: string | null = null;
    for (const ch of text) {
        if (quote) {
            cur += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '\'' || ch === '"') { quote = ch; cur += ch; continue; }
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim() !== '') parts.push(cur.trim());
    return parts;
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`(?:${IDENT}\.)?${IDENT}`;

/** The catalog spelling of an identifier: quoted keeps its case, unquoted folds to lower case. */
export function identName(raw: string): string {
    return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.toLowerCase();
}

const TABLE_RE = new RegExp(String.raw`^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(${QUALIFIED})\s*\(`, 'i');
const INDEX_RE = new RegExp(
    String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\s+(${IDENT})\s+ON\s+(?:ONLY\s+)?(${QUALIFIED})[\s(]`, 'i');
const ALTER_RE = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})\s+([\s\S]+)$`, 'i');
const ADD_COLUMN_RE = new RegExp(String.raw`^ADD\s+(?:COLUMN\s+)?IF\s+NOT\s+EXISTS\s+(${IDENT})\s`, 'i');

/** Recognize one statement, or null when it is not one the guard may skip. */
export function classifyStatement(sql: string): GuardedStatement | null {
    const s = sql.trim();
    let m = TABLE_RE.exec(s);
    if (m) return { kind: 'table', sql: s, table: m[1]! };
    m = INDEX_RE.exec(s);
    if (m) return { kind: 'index', sql: s, table: m[2]!, index: identName(m[1]!) };
    m = ALTER_RE.exec(s);
    if (m) {
        const clauses = splitTopLevelCommas(m[2]!);
        const columns: string[] = [];
        for (const clause of clauses) {
            const c = ADD_COLUMN_RE.exec(clause + ' ');
            if (!c) return null; // any other ALTER action: not a no-op candidate
            columns.push(identName(c[1]!));
        }
        if (columns.length > 0) return { kind: 'columns', sql: s, table: m[1]!, columns };
    }
    return null;
}

/** Recognize every statement of `text`, or null when any one is not recognized (the text then passes through). */
export function classifyDdl(text: string): GuardedStatement[] | null {
    const stmts = splitSqlStatements(text);
    if (stmts.length === 0) return null;
    const out: GuardedStatement[] = [];
    for (const st of stmts) {
        const g = classifyStatement(st);
        if (!g) return null;
        out.push(g);
    }
    return out;
}

/** True when the statement's object already exists (catalog reads only; no table lock). */
export async function alreadyDone(q: Q, st: GuardedStatement): Promise<boolean> {
    if (st.kind === 'table') {
        const r = await q.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [st.table]);
        return r.rows[0]?.ok === true;
    }
    if (st.kind === 'index') {
        // IF NOT EXISTS matches any relation of that name in the table's schema (an INVALID index counts too:
        // Postgres would skip it as well, and the background builders own dropping and rebuilding those).
        const r = await q.query<{ ok: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_class c
                             WHERE c.relname = $1
                               AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = to_regclass($2))) AS ok`,
            [st.index, st.table]);
        return r.rows[0]?.ok === true;
    }
    const r = await q.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_attribute
          WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped AND attname = ANY($2::text[])`,
        [st.table, st.columns]);
    return Number(r.rows[0]?.n ?? 0) === new Set(st.columns).size;
}

const SKIPPED: QueryResult = { command: 'SKIP', rowCount: 0, oid: 0, rows: [], fields: [] };

/** Run recognized DDL statement by statement, skipping the ones already done. Returns the last real result. */
export async function runGuardedDdl(q: Q, stmts: GuardedStatement[]): Promise<QueryResult> {
    let last: QueryResult = SKIPPED;
    for (const st of stmts) {
        if (await alreadyDone(q, st)) continue;
        last = await q.query(st.sql);
    }
    return last;
}

/**
 * Wrap a bootstrap client so plain-text idempotent DDL skips objects that already exist (see the header).
 * Only `query(text)` with a single string argument is intercepted; every other call and property goes to
 * the real client.
 */
export function lockFreeDdlClient(client: PoolClient): PoolClient {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    const raw: Q = { query: query as Q['query'] };
    const guarded = (...args: unknown[]): unknown => {
        if (args.length === 1 && typeof args[0] === 'string') {
            const stmts = classifyDdl(args[0]);
            if (stmts) return runGuardedDdl(raw, stmts);
        }
        return query(...args);
    };
    return new Proxy(client, {
        get(target, prop) {
            if (prop === 'query') return guarded;
            const v = Reflect.get(target, prop) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
    });
}
