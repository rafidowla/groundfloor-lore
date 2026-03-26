/**
 * Type declarations for @kineviz/kuzu-lite.
 *
 * Purpose: Re-exports types from the shipped kuzu.d.ts file since
 *   the package.json lacks a "types" field.
 */
declare module '@kineviz/kuzu-lite' {
    export {
        Database,
        Connection,
        PreparedStatement,
        QueryResult,
        type KuzuValue,
        type NodeValue,
        type RelValue,
        type RecursiveRelValue,
        type NodeID,
        type SystemConfig,
        type Nullable,
        type Callback,
        type ProgressCallback,
    } from '@kineviz/kuzu-lite/kuzu';
}

declare module '@kineviz/kuzu-lite/kuzu' {
    export type Nullable<T> = T | null;
    export type Callback<T = void> = (error: Error | null, result?: T) => void;
    export type ProgressCallback = (
        pipelineProgress: number,
        numPipelinesFinished: number,
        numPipelines: number
    ) => void;

    export type KuzuValue =
        | null | boolean | number | bigint | string | Date
        | NodeValue | RelValue | RecursiveRelValue
        | KuzuValue[] | { [key: string]: KuzuValue };

    export interface NodeID { offset: number; table: number; }
    export interface NodeValue { _label: string | null; _id: NodeID | null; [key: string]: any; }
    export interface RelValue { _src: NodeID | null; _dst: NodeID | null; _label: string | null; _id: any; [key: string]: any; }
    export interface RecursiveRelValue { _nodes: any[]; _rels: any[]; }
    export interface SystemConfig {
        bufferPoolSize?: number; enableCompression?: boolean;
        readOnly?: boolean; maxDBSize?: number;
        autoCheckpoint?: boolean; checkpointThreshold?: number;
    }

    export class Database {
        constructor(databasePath?: string, bufferManagerSize?: number, enableCompression?: boolean,
            readOnly?: boolean, maxDBSize?: number, autoCheckpoint?: boolean, checkpointThreshold?: number);
        init(): Promise<void>;
        close(): Promise<void>;
        static getVersion(): string;
    }

    export class Connection {
        constructor(database: Database, numThreads?: number);
        init(): Promise<void>;
        close(): Promise<void>;
        setMaxNumThreadForExec(numThreads: number): void;
        setQueryTimeout(timeoutInMs: number): void;
        execute(preparedStatement: PreparedStatement, params?: Record<string, KuzuValue>,
            progressCallback?: ProgressCallback): Promise<QueryResult | QueryResult[]>;
        prepare(statement: string): Promise<PreparedStatement>;
        query(statement: string, progressCallback?: ProgressCallback): Promise<QueryResult | QueryResult[]>;
    }

    export class PreparedStatement {
        isSuccess(): boolean;
        getErrorMessage(): string;
    }

    export class QueryResult {
        resetIterator(): void;
        hasNext(): boolean;
        getNumTuples(): number;
        getNext(): Promise<Record<string, KuzuValue> | null>;
        getAll(): Promise<Record<string, KuzuValue>[]>;
        getColumnDataTypes(): Promise<string[]>;
        getColumnNames(): Promise<string[]>;
        close(): void;
    }
}
