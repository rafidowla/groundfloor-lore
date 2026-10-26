/**
 * workspacesDeleted.ts — `lore workspaces deleted | restore | erase-now` (lane f6b).
 *
 * Deliberately CLI-only. There is no HTTP route for restore: restoring is a local, operator-level action on the
 * machine that holds the Lore home (adding a route would need a new permission decision).
 */

import { listDeletions, restoreWorkspace, type DeletedRow } from '../../engines/workspaceErase/restore.js';
import { eraseNow } from '../../engines/workspaceErase/tick.js';
import { NOT_REACHED_NOTICE } from '../../engines/workspaceErase/config.js';

export function printDeleted(json: boolean): void {
    const rows = listDeletions();
    if (json) { console.log(JSON.stringify({ deleted: rows }, null, 2)); return; }
    if (rows.length === 0) { console.log('No deleted workspaces.'); return; }
    for (const r of rows) {
        console.log(`${r.id}  ${r.name.padEnd(20)} ${r.state.padEnd(11)} ${r.summary}`);
        if (r.state === 'erased' || r.state === 'partial' || r.state === 'needs-operator') printReceipt(r);
    }
    console.log(`\n${NOT_REACHED_NOTICE}`);
}

function printReceipt(r: DeletedRow): void {
    for (const s of r.receipt ?? []) console.log(`      ${s.store.padEnd(18)} ${s.status}${s.detail ? ` — ${s.detail}` : ''}`);
}

export async function runRestore(id: string | undefined, as: string | undefined): Promise<void> {
    if (!id) { console.error('restore: missing workspace id. Usage: lore workspaces restore <id> [--as <new-name>]  (see: lore workspaces deleted)'); process.exit(1); }
    try {
        const r = await restoreWorkspace(id, as !== undefined ? { as } : {});
        console.log(`Restored "${r.name}" (id ${r.id}) at ${r.path}.`);
        console.log('Restart the Lore service so it picks the workspace up again.');
    } catch (e) { console.error(`restore: ${(e as Error).message}`); process.exit(1); }
}

export async function runEraseNow(id: string | undefined): Promise<void> {
    if (!id) { console.error('erase-now: missing workspace id. Usage: lore workspaces erase-now <id>  (see: lore workspaces deleted)'); process.exit(1); }
    try {
        const out = await eraseNow(id);
        if (out.kind === 'complete') { console.log(`Erased workspace ${id}: complete.`); printStores(out.receipt.stores); console.log(NOT_REACHED_NOTICE); return; }
        if (out.kind === 'partial') { console.error(`Workspace ${id} was only partly erased; Lore will retry on its schedule.`); printStores(out.receipt.stores); process.exit(2); }
        if (out.kind === 'needs-operator') { console.error(`Workspace ${id} still cannot be verified; Lore stopped retrying it. An operator must check the stores below, then run erase-now again.`); printStores(out.receipt.stores); process.exit(2); }
        if (out.kind === 'failed') { console.error(`Erase failed (attempt ${out.attempt}): ${out.error}. Lore will retry on its schedule.`); process.exit(2); }
        console.error(`Not erased: ${'reason' in out ? out.reason : 'unknown'}`); process.exit(1);
    } catch (e) { console.error(`erase-now: ${(e as Error).message}`); process.exit(1); }
}

function printStores(stores: ReadonlyArray<{ store: string; status: string; detail?: string }>): void {
    for (const s of stores) console.log(`  ${s.store.padEnd(18)} ${s.status}${s.detail ? ` — ${s.detail}` : ''}`);
}
