/**
 * Fluent query builder for the TypeScript SDK (v3.2 Block 3).
 *
 * Purpose: Provide a Supabase-style ergonomic API on top of
 *   GroundfloorClient.query(). Pure client-side sugar — no engine contract
 *   changes.
 * Inputs: tenant + collection at construction; chained where/limit/orderBy/etc.
 * Outputs: Promise<records[]> on fetch().
 * Error Behavior: Propagates underlying query() errors.
 * Side Effects: None until fetch() is awaited.
 * State Contract: Mutates builder in place via fluent methods; final fetch()
 *   forwards a QueryOptions to the client.
 * Determinism & Idempotency: Deterministic query shape; idempotent fetch.
 * Concurrency Considerations: One builder = one query; reuse is fine.
 * Performance Notes: Zero overhead beyond the HTTP call query() would make.
 * Observability Expectations: Inherits the client's fetch logging/auth path.
 */
import type { QueryOptions, QueryResult, RecordData } from "./types";
type FluentOp = "=" | "==" | "!=" | "<>" | ">" | ">=" | "<" | "<=" | "in" | "like" | "contains" | "starts_with" | "ends_with";
export declare class QueryBuilder<T extends RecordData = RecordData> {
    private readonly client;
    private readonly collection;
    private clauses;
    private _limit?;
    private _offset?;
    private _sort;
    private _projection?;
    private _distinct?;
    private _connection?;
    constructor(client: {
        query: (c: string, o?: QueryOptions, conn?: string) => Promise<QueryResult<T>>;
    }, collection: string);
    where(field: string, op: FluentOp | string, value: any): this;
    limit(n: number): this;
    offset(n: number): this;
    orderBy(field: string, direction?: "asc" | "desc"): this;
    select(...fields: string[]): this;
    distinct(on?: boolean): this;
    connection(name: string): this;
    private filter;
    fetch(): Promise<T[]>;
}
export {};
