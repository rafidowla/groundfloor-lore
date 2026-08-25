/**
 * keytarLoader.ts — lazy loader for the optional `keytar` native module.
 *
 * Purpose:
 *   keytar provides OS-keychain access (macOS Keychain, Windows Credential
 *   Vault, libsecret). Its native bindings can fail to load on sandboxed CI
 *   or bare Linux without libsecret. Both the API-key store (config/keychain.ts)
 *   and the per-workspace encryption keyring (security/keyring.ts) need the
 *   same "try to load keytar, cache the result, never throw" behaviour.
 *   This module is the single source of that behaviour.
 *
 * Side Effects: dynamically imports `keytar` on first call; caches the result
 *   (including a null on failure) process-wide.
 * Error Behavior: never throws — returns null and logs to stderr on failure.
 * Determinism: deterministic after the first resolution.
 */

export type KeytarLike = {
    setPassword: (service: string, account: string, password: string) => Promise<void>;
    getPassword: (service: string, account: string) => Promise<string | null>;
    deletePassword: (service: string, account: string) => Promise<boolean>;
};

let keytarModule: KeytarLike | null | undefined;

/**
 * loadKeytar — resolve the keytar module, or null if its native bindings are
 * unavailable. The result is cached after the first call, so the dynamic
 * import and any failure log happen at most once.
 *
 * @param logPrefix bracketed tag used in the stderr message on failure
 *   (e.g. `[keychain]`, `[keyring]`) so logs identify the calling subsystem.
 */
export async function loadKeytar(logPrefix: string): Promise<KeytarLike | null> {
    if (keytarModule !== undefined) return keytarModule;
    try {
        const mod = (await import('keytar')) as unknown as { default?: KeytarLike } & KeytarLike;
        keytarModule = mod.default ?? mod;
        return keytarModule;
    } catch (err) {
        console.error(`${logPrefix} keytar unavailable:`, (err as Error).message);
        keytarModule = null;
        return null;
    }
}

/**
 * resetKeytarCacheForTests — clear the cached module so a unit test can
 * re-exercise the load path. Not for production use.
 */
export function resetKeytarCacheForTests(): void {
    keytarModule = undefined;
}
