/**
 * operatorIdentity.ts — Local-mode operator identity binding.
 *
 * Per the auth-mode-decision (2026-05-10): Lore in `--mode=local` still
 * runs ReBAC. To avoid an interactive Clerk popup on every daemon boot
 * (and to preserve offline-first behavior), the OPERATOR — the human
 * who owns this Mac and runs the local Lore daemon — is bound to a
 * `portal_user` identity ONCE at setup time. From then on the daemon
 * reads the cached identity and binds it as the ActorContext for any
 * request that doesn't otherwise carry a Clerk JWT.
 *
 * Storage shape:
 *   <LORE_HOME>/operator.json
 *   {
 *     "portalUserId": "user_abc123",
 *     "displayName": "Rafi Dowla",
 *     "scopes": ["read", "admin"],         // what the workspace seed gave us
 *     "boundAt": "2026-05-10T12:34:56Z",
 *     "source": "clerk-setup" | "manual"
 *   }
 *
 * File-mode 0600. The file is per-machine — not synced. If the
 * operator's Mac changes, run `lore operator init` again on the new
 * machine; the portal_user id stays the same (Clerk identity is
 * per-human, not per-device).
 *
 * This module is FILE I/O ONLY — no Clerk SDK calls, no network. The
 * setup command + `lore operator init` are responsible for actually
 * resolving a portal_user (via Clerk login when CLERK_ISSUER is set,
 * or via a manual flag for offline / dev-only use).
 */

import fs from 'node:fs';
import path from 'node:path';
import { loreHome } from '../config/loreHome.js';

export interface OperatorIdentity {
    portalUserId: string;
    displayName?: string;
    scopes: string[];
    boundAt: string;
    source: 'clerk-setup' | 'manual';
}

const FILE_NAME = 'operator.json';

export function operatorIdentityPath(home: string = loreHome()): string {
    return path.join(home, FILE_NAME);
}

/**
 * Read the operator-identity file. Returns null when the file is
 * absent (operator hasn't run setup yet) or when its content is
 * malformed (caller treats both as "no operator bound" — the daemon
 * still serves localhost, just without a request-bound actor).
 */
export function readOperatorIdentity(home: string = loreHome()): OperatorIdentity | null {
    const p = operatorIdentityPath(home);
    if (!fs.existsSync(p)) return null;
    try {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const portalUserId = parsed['portalUserId'];
        const boundAt = parsed['boundAt'];
        const source = parsed['source'];
        if (typeof portalUserId !== 'string' || portalUserId.length === 0) return null;
        if (typeof boundAt !== 'string' || boundAt.length === 0) return null;
        if (source !== 'clerk-setup' && source !== 'manual') return null;
        return {
            portalUserId,
            displayName: typeof parsed['displayName'] === 'string'
                ? parsed['displayName'] as string : undefined,
            scopes: Array.isArray(parsed['scopes'])
                ? (parsed['scopes'] as unknown[]).filter((s): s is string => typeof s === 'string')
                : [],
            boundAt,
            source,
        };
    } catch {
        return null;
    }
}

/**
 * Write the operator-identity file with mode 0600. Idempotent —
 * overwrites the existing file. Caller is responsible for ensuring
 * the LORE_HOME directory exists.
 */
export function writeOperatorIdentity(
    identity: OperatorIdentity,
    home: string = loreHome(),
): void {
    const p = operatorIdentityPath(home);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(p, JSON.stringify(identity, null, 2), { encoding: 'utf8', mode: 0o600 });
    // Re-apply mode in case the file existed with looser permissions.
    try { fs.chmodSync(p, 0o600); } catch { /* best-effort */ }
}

/**
 * Remove the operator-identity binding. Used by `lore operator clear`
 * for re-binding to a different account (uncommon — typically only
 * needed when migrating Lore between Clerk tenants).
 */
export function clearOperatorIdentity(home: string = loreHome()): boolean {
    const p = operatorIdentityPath(home);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
}
