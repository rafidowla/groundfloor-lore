export interface Memory {
    id: string;
    text: string;
    createdAt: string;
    project: string;
    entities: string[];
    topics: string[];
}

export type QuestionKind = 'paraphrase' | 'keyword' | 'mixed';

export interface EvalQuestion {
    qid: string;
    question: string;
    gold: string;
    kind: QuestionKind;
}

export interface AliasEntry {
    id: string;
    questions: string[];
    summary: string;
    entities: string[];
    topics: string[];
}

export interface RephrasingEntry {
    qid: string;
    queries: string[];
}

export type ConfigId = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8' | 'C9';

export interface ConfigSpec {
    id: ConfigId;
    label: string;
    searchMode: 'keyword' | 'semantic' | 'hybrid';
    /** Write alias questions[]/summary/entities/topics onto each memory node. */
    useQuestionsAtWrite: boolean;
    /** Pass the 3 caller-authored rephrasings as `queries[]` alongside the
     *  original question text at recall time. */
    useQueriesAtRead: boolean;
    /** D8 (3.23/3.24) — per-call `rerank:true` (local cross-encoder over the
     *  top hits). Needs the rerank model in the bench home's `models/`
     *  cache; see run.ts `--rerank-model-dir`. */
    rerank?: boolean;
    /** D7 (3.23) — `createLore({ pieceVectors: true })`: piece-level vectors
     *  built at write time and routed to at read time. */
    pieceVectors?: boolean;
}

export const CONFIGS: ConfigSpec[] = [
    { id: 'C1', label: 'BM25 only (keyword)', searchMode: 'keyword', useQuestionsAtWrite: false, useQueriesAtRead: false },
    { id: 'C2', label: 'Dense only (semantic)', searchMode: 'semantic', useQuestionsAtWrite: false, useQueriesAtRead: false },
    { id: 'C3', label: 'RRF hybrid (default)', searchMode: 'hybrid', useQuestionsAtWrite: false, useQueriesAtRead: false },
    { id: 'C4', label: 'Hybrid + questions[] at write', searchMode: 'hybrid', useQuestionsAtWrite: true, useQueriesAtRead: false },
    { id: 'C5', label: 'Hybrid + queries[] (rephrasings) at read', searchMode: 'hybrid', useQuestionsAtWrite: false, useQueriesAtRead: true },
    { id: 'C6', label: 'Hybrid + questions[] at write + queries[] at read', searchMode: 'hybrid', useQuestionsAtWrite: true, useQueriesAtRead: true },
    { id: 'C7', label: 'C6 + rerank', searchMode: 'hybrid', useQuestionsAtWrite: true, useQueriesAtRead: true, rerank: true },
    { id: 'C8', label: 'C6 + piece vectors', searchMode: 'hybrid', useQuestionsAtWrite: true, useQueriesAtRead: true, pieceVectors: true },
    { id: 'C9', label: 'C6 + piece vectors + rerank', searchMode: 'hybrid', useQuestionsAtWrite: true, useQueriesAtRead: true, pieceVectors: true, rerank: true },
];

/** What runs when `--configs` is omitted — the original six, so a default
 *  run stays comparable with every prior RESULTS.md round and never needs
 *  the rerank model. C7–C9 are opt-in. */
export const DEFAULT_CONFIG_IDS: ConfigId[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
