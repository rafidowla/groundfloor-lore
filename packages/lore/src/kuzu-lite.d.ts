// Ambient declaration for @kineviz/kuzu-lite.
//
// The package ships a hand-written `kuzu.d.ts` but doesn't set
// `"types"` in its package.json, so TypeScript's module resolver
// can't find it after the V2.1 workspace split rebased rootDir.
// These declarations mirror the surface the engine actually uses.
declare module '@kineviz/kuzu-lite' {
    export class Database {
        constructor(path: string);
        close(): Promise<void>;
    }
    export class Connection {
        constructor(database: Database);
        query(cypher: string): Promise<QueryResult>;
        prepare(cypher: string): Promise<PreparedStatement>;
        execute(stmt: PreparedStatement, params: Record<string, unknown>): Promise<QueryResult>;
        close(): Promise<void>;
    }
    export interface PreparedStatement {
        [key: string]: unknown;
    }
    export interface QueryResult {
        getAll(): Promise<Array<Record<string, unknown>>>;
    }
}
