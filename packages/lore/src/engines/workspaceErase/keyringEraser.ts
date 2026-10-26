/**
 * workspaceErase/keyringEraser.ts — forgets the workspace's encryption key in the OS keychain (lane f6b).
 *
 * The keychain entry is keyed by workspace NAME and is global to the machine user, not to a Lore home. So this
 * eraser only acts when (a) it is enabled for this home (the default Lore home), and (b) no live registry entry
 * carries the name — a new workspace re-using the name would otherwise lose its key. Anything else is
 * `not-applicable` with the reason. It runs last: once the key is gone, any ciphertext that survived is unreadable.
 */

import { readLiveEntriesStrict, liveClaims } from './liveRegistry.js';
import type { EraseOptions, EraseStepResult, EraseTarget, WorkspaceEraser } from './types.js';

const STORE = 'keyring';

export interface KeyringOps {
    has(name: string): Promise<boolean>;
    remove(name: string): Promise<boolean>;
}

export interface KeyringEraserDeps {
    home: string;
    /** False when this home is not the machine's default Lore home (the keychain is global by name). */
    enabled: boolean;
    ops?: KeyringOps;
}

async function realOps(): Promise<KeyringOps> {
    const k = await import('../../security/keyring.js');
    return { has: k.hasWorkspaceKey, remove: k.deleteWorkspaceKey };
}

const res = (status: EraseStepResult['status'], detail?: string, removed: Record<string, number> = {}, remaining: Record<string, number> = {}): EraseStepResult =>
    ({ store: STORE, status, removed, remaining, ...(detail ? { detail } : {}) });

export function createKeyringEraser(deps: KeyringEraserDeps): WorkspaceEraser {
    return {
        store: STORE,
        async erase(target: EraseTarget, _opts?: EraseOptions): Promise<EraseStepResult> {
            if (!deps.enabled) return res('not-applicable', 'the OS keychain is shared by name across Lore homes; this home is not the default one, so no key was touched');
            let live;
            try { live = readLiveEntriesStrict(deps.home); }
            catch (e) { return res('partial', `could not read the workspace registry, so no key was touched (${(e as Error).message})`); }
            if (liveClaims(live, { id: target.id, name: target.name, paths: [] }).byName) {
                return res('not-applicable', 'a live workspace now uses this name, so its keychain entry was left alone');
            }
            const ops = deps.ops ?? await realOps();
            let had: boolean;
            try { had = await ops.has(target.name); } catch { return res('partial', 'the keychain could not be read; it will be retried'); }
            if (!had) return res('not-applicable', 'no keychain entry existed for this workspace', {}, { keys: 0 });
            try { await ops.remove(target.name); } catch { /* verified below */ }
            let still: boolean;
            try { still = await ops.has(target.name); } catch { return res('partial', 'the keychain entry could not be verified after removal; it will be retried'); }
            return still
                ? res('partial', 'the keychain entry is still present after removal; it will be retried', {}, { keys: 1 })
                : res('complete', undefined, { keys: 1 }, { keys: 0 });
        },
    };
}
