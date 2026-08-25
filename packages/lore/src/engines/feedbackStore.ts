/**
 * feedbackStore.ts — 👍 / 👎 reactions on chat bubbles (V2.2).
 *
 * Cheap quality signal for "is this LLM actually helping?" Aggregates
 * over time become the data we need to tune model selection and
 * grounding-prompt quality. No user text feedback in v1 — one click
 * per bubble, either thumb, change your mind by clicking again.
 *
 * Storage: append-only JSONL at ~/.groundfloor/feedback.jsonl.
 * Same 0600-perm + log-rotation pattern as audit.jsonl (handled at
 * boot by security/logRotator — see rotateStandardLogs).
 *
 * Deduplication: the most recent rating for a given messageId wins
 * at stats-aggregation time. We never rewrite history — the full
 * timeline of {up, down, up, down} is preserved for future analysis.
 *
 * Privacy: stored LOCALLY. Never egressed unless the user opts into
 * telemetry. Query hashes (not query text) are recorded so aggregate
 * stats can cluster by question similarity without preserving prose.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { loreHome, loreHomePath } from '../config/loreHome.js';

export type Rating = 'up' | 'down';

export interface FeedbackEntry {
    timestamp: string;
    messageId: string;
    provider: string;
    model: string;
    rating: Rating;
    /** SHA256 prefix of the query text — lets aggregation cluster
     *  same-query repeats without storing the raw text. */
    queryHash: string;
    /** Length of the assistant's response body (bytes). Useful
     *  signal: did the model produce nothing useful, or was it long
     *  but wrong? */
    responseLength?: number;
}

export interface FeedbackAggregate {
    totalCount: number;
    providerBreakdown: Record<string, { up: number; down: number; total: number; upRate: number }>;
    modelBreakdown: Record<string, { up: number; down: number; total: number; upRate: number }>;
    recentEntries: FeedbackEntry[];
}

const DEFAULT_PATH = loreHomePath('feedback.jsonl');

export class FeedbackStore {
    private readonly filePath: string;

    constructor(filePath: string = DEFAULT_PATH) {
        this.filePath = filePath;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            if (!fs.existsSync(this.filePath)) {
                fs.writeFileSync(this.filePath, '', { mode: 0o600 });
            } else {
                try { fs.chmodSync(this.filePath, 0o600); } catch { /* best-effort */ }
            }
        } catch (err) {
            console.error(`[feedback] init failed: ${(err as Error).message}`);
        }
    }

    /** Compute a stable hash prefix for a query string. SHA-256 is
     *  overkill for this — plain collision resistance is enough —
     *  but it's in the standard library and takes a prefix. */
    static hashQuery(text: string): string {
        return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
    }

    record(entry: Omit<FeedbackEntry, 'timestamp'>): void {
        const full: FeedbackEntry = {
            timestamp: new Date().toISOString(),
            ...entry,
        };
        try {
            fs.appendFileSync(this.filePath, JSON.stringify(full) + '\n', { mode: 0o600 });
        } catch (err) {
            console.error(`[feedback] append failed: ${(err as Error).message}`);
        }
    }

    /** Read all entries since `sinceTimestamp` (ISO string) or all
     *  when omitted. Returns parsed entries in file order (oldest
     *  first). Malformed lines are skipped silently — append-only
     *  JSONL tolerates readers seeing partial writes. */
    readSince(sinceTimestamp?: string): FeedbackEntry[] {
        if (!fs.existsSync(this.filePath)) return [];
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const entries: FeedbackEntry[] = [];
            for (const line of raw.split('\n')) {
                if (!line) continue;
                try {
                    const e = JSON.parse(line) as FeedbackEntry;
                    if (sinceTimestamp && e.timestamp < sinceTimestamp) continue;
                    entries.push(e);
                } catch { /* ignore malformed */ }
            }
            return entries;
        } catch {
            return [];
        }
    }

    /** Aggregate stats over the given window (days). Dedup per
     *  messageId: only the latest rating for a message counts. */
    aggregate(windowDays: number = 30): FeedbackAggregate {
        const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
        const entries = this.readSince(new Date(sinceMs).toISOString());

        // Dedup: keep only the most recent entry per messageId.
        const latest = new Map<string, FeedbackEntry>();
        for (const e of entries) {
            const prev = latest.get(e.messageId);
            if (!prev || prev.timestamp < e.timestamp) {
                latest.set(e.messageId, e);
            }
        }

        const providerCounts = new Map<string, { up: number; down: number }>();
        const modelCounts = new Map<string, { up: number; down: number }>();

        for (const e of latest.values()) {
            const pc = providerCounts.get(e.provider) ?? { up: 0, down: 0 };
            if (e.rating === 'up') pc.up += 1; else pc.down += 1;
            providerCounts.set(e.provider, pc);

            const mc = modelCounts.get(e.model) ?? { up: 0, down: 0 };
            if (e.rating === 'up') mc.up += 1; else mc.down += 1;
            modelCounts.set(e.model, mc);
        }

        const toBreakdown = (m: Map<string, { up: number; down: number }>): Record<string, { up: number; down: number; total: number; upRate: number }> => {
            const out: Record<string, { up: number; down: number; total: number; upRate: number }> = {};
            for (const [k, v] of m.entries()) {
                const total = v.up + v.down;
                out[k] = {
                    up: v.up,
                    down: v.down,
                    total,
                    upRate: total === 0 ? 0 : v.up / total,
                };
            }
            return out;
        };

        // Recent raw entries (most recent 20, newest first) for
        // debug / transparency in Settings panel.
        const recentEntries = [...latest.values()]
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, 20);

        return {
            totalCount: latest.size,
            providerBreakdown: toBreakdown(providerCounts),
            modelBreakdown: toBreakdown(modelCounts),
            recentEntries,
        };
    }
}
