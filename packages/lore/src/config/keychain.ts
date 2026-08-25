/**
 * keychain.ts — OS keychain wrapper for API keys via keytar.
 *
 * Purpose:
 *   Keep BYOK API keys out of localStorage and config files. Uses the
 *   OS keychain (macOS Keychain, Windows Credential Vault, libsecret).
 *
 * Service namespace: `groundfloor-lore`.
 * Account = the LLM provider name (`anthropic`, `openai`, etc.), so each
 * provider gets its own slot.
 *
 * Fallback: If keytar native bindings fail to load (rare on sandboxed
 * CI or bare Linux without libsecret), all functions no-op and return
 * null. Caller must treat "no key" and "unsupported" identically.
 *
 * Side Effects: Reads/writes OS keychain.
 * Error Behavior: Never throws; returns null on failure and logs to stderr.
 * Determinism: Deterministic given unchanged keychain state.
 */

import { loadKeytar } from '../security/keytarLoader.js';

const SERVICE = 'groundfloor-lore';

const load = (): ReturnType<typeof loadKeytar> => loadKeytar('[keychain]');

export async function setApiKey(provider: string, apiKey: string): Promise<boolean> {
    const k = await load();
    if (!k) return false;
    try {
        await k.setPassword(SERVICE, provider, apiKey);
        return true;
    } catch (err) {
        console.error('[keychain] setApiKey failed:', (err as Error).message);
        return false;
    }
}

export async function getApiKey(provider: string): Promise<string | null> {
    const k = await load();
    if (!k) return null;
    try {
        return await k.getPassword(SERVICE, provider);
    } catch (err) {
        console.error('[keychain] getApiKey failed:', (err as Error).message);
        return null;
    }
}

export async function deleteApiKey(provider: string): Promise<boolean> {
    const k = await load();
    if (!k) return false;
    try {
        return await k.deletePassword(SERVICE, provider);
    } catch (err) {
        console.error('[keychain] deleteApiKey failed:', (err as Error).message);
        return false;
    }
}

export async function hasApiKey(provider: string): Promise<boolean> {
    return (await getApiKey(provider)) !== null;
}
