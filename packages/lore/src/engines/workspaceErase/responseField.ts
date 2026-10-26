/**
 * workspaceErase/responseField.ts — the additive `erase` field on the HTTP delete response (lane f6b).
 *
 * Plain facts for the caller: when the data is (or will be) erased, how to undo it, and what Lore cannot reach.
 */

import { NOT_REACHED_NOTICE } from './config.js';
import type { DeleteLifecycleResult } from './lifecycle.js';

export interface EraseResponseField {
    /** 'scheduled' = hidden, erased after the window; 'erased' = erased now; 'erasing' = erase started, being finished; 'not-scheduled' = data kept (another workspace uses it). */
    status: DeleteLifecycleResult['status'];
    eraseAfter: string | null;
    windowDays: number;
    /** CLI command that undoes the delete while the window is open; null when there is nothing to restore. */
    restoreCommand: string | null;
    notReached: string;
    note?: string;
}

export function eraseResponseField(r: DeleteLifecycleResult): EraseResponseField {
    return {
        status: r.status,
        eraseAfter: r.eraseAfter,
        windowDays: r.windowDays,
        restoreCommand: r.status === 'scheduled' ? `lore workspaces restore ${r.id}` : null,
        notReached: NOT_REACHED_NOTICE,
        ...(r.note ? { note: r.note } : {}),
    };
}
