/**
 * keyring.ts — Per-workspace encryption-key manager backed by the OS
 * keychain (Phase 3 / S6).
 *
 * Key lifecycle:
 *   - On first request for workspace `<name>`, generate a fresh 256-bit
 *     random key and store in the OS keychain under account
 *     `encryption:<name>` within service `groundfloor-lore`.
 *   - On subsequent requests, retrieve from the keychain.
 *   - Rotation: `rotate(name)` generates a new key and stores it. Old
 *     key is forgotten; any data encrypted with it becomes unreadable.
 *     Intentional — rotation is a big-deal operation; callers MUST
 *     re-encrypt their data with the new key first.
 *
 * Why per-workspace:
 *   - Each workspace (workspace-A, workspace-B, ...) has different
 *     sensitivity. Compromising one key doesn't reveal another.
 *   - Users may want to delete a workspace + its data irrevocably —
 *     deleting the key makes that instant.
 *
 * Why keychain (not a file):
 *   - File-based key storage undermines the point: if an attacker can
 *     read the graph, they can read the key.
 *   - OS keychain puts the key behind user-login auth (and on macOS,
 *     TouchID / hardware-backed Secure Enclave for modern machines).
 *   - Same mechanism we already use for API keys (keychain.ts) —
 *     consistent security posture.
 *
 * Scope for S6:
 *   - create + retrieve + rotate + delete. No enumeration (keytar
 *     doesn't expose a list-all API anyway).
 *   - No on-first-access UI prompt — keychain unlock happens at user
 *     login, so key retrieval is transparent within that session.
 */

import { generateKey } from './encryption.js';
import { loadKeytar } from './keytarLoader.js';

const SERVICE = 'groundfloor-lore';

const load = (): ReturnType<typeof loadKeytar> => loadKeytar('[keyring]');

function account(workspaceName: string): string {
    // Namespaced so the same keychain can hold API keys (account =
    // provider name) AND encryption keys (account = encryption:<ws>)
    // without collision.
    return `encryption:${workspaceName}`;
}

/**
 * getWorkspaceKey — retrieve the key for `workspaceName`, generating
 * one on first access.
 *
 * Return type is Buffer (not string) so callers can't accidentally
 * treat the key as printable text. The keychain stores it hex-encoded
 * to survive keytar's string-only API.
 */
export async function getWorkspaceKey(workspaceName: string): Promise<Buffer | null> {
    const k = await load();
    if (!k) return null;

    const acct = account(workspaceName);
    try {
        const hex = await k.getPassword(SERVICE, acct);
        if (hex) return Buffer.from(hex, 'hex');

        // First access — generate + store.
        const fresh = generateKey();
        await k.setPassword(SERVICE, acct, fresh.toString('hex'));
        return fresh;
    } catch (err) {
        console.error(`[keyring] getWorkspaceKey(${workspaceName}) failed:`, (err as Error).message);
        return null;
    }
}

/**
 * rotateWorkspaceKey — generate a new key, REPLACING the existing one.
 *
 * Destructive: any data encrypted with the old key is unreadable after
 * rotation. Callers MUST re-encrypt their data with the new key first
 * (pattern: decrypt-with-old → rotate → encrypt-with-new).
 *
 * Returns the new key so the caller can use it directly for the
 * re-encryption pass without a second lookup.
 */
export async function rotateWorkspaceKey(workspaceName: string): Promise<Buffer | null> {
    const k = await load();
    if (!k) return null;

    const fresh = generateKey();
    try {
        await k.setPassword(SERVICE, account(workspaceName), fresh.toString('hex'));
        return fresh;
    } catch (err) {
        console.error(`[keyring] rotateWorkspaceKey(${workspaceName}) failed:`, (err as Error).message);
        return null;
    }
}

/**
 * deleteWorkspaceKey — forget the key entirely.
 *
 * Use this as the final step of `lore workspaces delete <name>` after
 * the on-disk data has already been removed. Any ciphertext that
 * survived the delete becomes permanently unreadable — intentional.
 */
export async function deleteWorkspaceKey(workspaceName: string): Promise<boolean> {
    const k = await load();
    if (!k) return false;
    try {
        return await k.deletePassword(SERVICE, account(workspaceName));
    } catch (err) {
        console.error(`[keyring] deleteWorkspaceKey(${workspaceName}) failed:`, (err as Error).message);
        return false;
    }
}

/**
 * hasWorkspaceKey — does a key already exist? Does NOT generate one
 * as a side effect. Useful for `lore doctor`-style readiness checks.
 */
export async function hasWorkspaceKey(workspaceName: string): Promise<boolean> {
    const k = await load();
    if (!k) return false;
    try {
        const v = await k.getPassword(SERVICE, account(workspaceName));
        return v != null && v.length > 0;
    } catch {
        return false;
    }
}
