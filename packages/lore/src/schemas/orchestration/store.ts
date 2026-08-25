/**
 * orchestration/store.ts — Phase 4 item 4.
 *
 * Persistence for the PlanOrchestrator. State lives at
 * `<workspace>/.lore/orchestrations.json`. Atomic write-rename on
 * every save so a crash mid-tick can't leave a half-written file.
 *
 * Tolerant of corruption: an unparseable file is replaced with an
 * empty list on next save rather than crashing the daemon. The
 * MigrationCheckpointStore in this codebase already proves this
 * pattern works for similar long-lived plan state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OrchestrationState } from './types.js';

const FILE_NAME = 'orchestrations.json';

export class OrchestrationStore {
    private readonly filePath: string;

    constructor(loreDir: string) {
        fs.mkdirSync(loreDir, { recursive: true });
        this.filePath = path.join(loreDir, FILE_NAME);
    }

    get path(): string { return this.filePath; }

    loadAll(): OrchestrationState[] {
        if (!fs.existsSync(this.filePath)) return [];
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed as OrchestrationState[];
        } catch {
            // Corrupt — next save replaces it. Don't crash the daemon.
            return [];
        }
    }

    load(id: string): OrchestrationState | null {
        return this.loadAll().find(o => o.id === id) ?? null;
    }

    saveAll(states: OrchestrationState[]): void {
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(states, null, 2), 'utf-8');
        fs.renameSync(tmp, this.filePath);
    }

    /** Upsert one orchestration. Other entries are preserved. */
    save(state: OrchestrationState): void {
        const all = this.loadAll();
        const idx = all.findIndex(o => o.id === state.id);
        if (idx >= 0) all[idx] = state; else all.push(state);
        this.saveAll(all);
    }

    /** Remove one orchestration. No-op when missing. */
    remove(id: string): void {
        const all = this.loadAll().filter(o => o.id !== id);
        this.saveAll(all);
    }
}
