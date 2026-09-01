/**
 * Debug-only recall stage timings (WP5). Off unless LORE_RECALL_STAGE_TIMING=1.
 * Concurrent retrieve() calls keep separate bags via AsyncLocalStorage.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { log } from '../logger.js';

export type RecallStageName = 'embed' | 'vector' | 'fts' | 'hydrate' | 'filter';

export type RecallStageMs = Partial<Record<RecallStageName, number>>;

const als = new AsyncLocalStorage<RecallStageMs>();

export function recallStageTimingEnabled(): boolean {
    return process.env['LORE_RECALL_STAGE_TIMING'] === '1';
}

function addMs(bag: RecallStageMs, stage: RecallStageName, elapsed: number): void {
    bag[stage] = Math.round(((bag[stage] ?? 0) + elapsed) * 10) / 10;
}

export async function withRecallStageTiming<T>(fn: () => Promise<T>): Promise<T> {
    if (!recallStageTimingEnabled()) return fn();
    const stages: RecallStageMs = {};
    const t0 = performance.now();
    try {
        return await als.run(stages, fn);
    } finally {
        log.info('recall_stage_timing', {
            ...stages,
            total_ms: Math.round((performance.now() - t0) * 10) / 10,
        });
    }
}

export async function timeRecallStage<T>(stage: RecallStageName, fn: () => Promise<T>): Promise<T> {
    const bag = als.getStore();
    if (!bag) return fn();
    const t0 = performance.now();
    try {
        return await fn();
    } finally {
        addMs(bag, stage, performance.now() - t0);
    }
}

export function timeRecallStageSync<T>(stage: RecallStageName, fn: () => T): T {
    const bag = als.getStore();
    if (!bag) return fn();
    const t0 = performance.now();
    try {
        return fn();
    } finally {
        addMs(bag, stage, performance.now() - t0);
    }
}
