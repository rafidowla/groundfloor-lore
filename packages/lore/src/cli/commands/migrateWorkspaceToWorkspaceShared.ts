/**
 * migrateWorkspaceToWorkspaceShared.ts — daemon preflight helpers
 * shared by `lore migrate workspace-to-workspace` and `lore compact`.
 *
 * Both commands touch a workspace's stores from outside the daemon. `lore
 * compact` compacts the LanceDB tables under `.lore/lancedb/` (its former
 * graph-engine half was removed along with that engine, 2026-08-21); `lore migrate
 * workspace-to-workspace` opens the graph store each side declares. The
 * stores are single-writer at the file level — surrealkv by directory lock,
 * LanceDB by table lock — so a concurrent CLI write while the daemon holds
 * the same `.lore/` would corrupt it or fail to open. Both commands
 * therefore probe `http://127.0.0.1:<LORE_PORT||3847>/api/health` and
 * refuse on a live response.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Exported (SW-11) so other CLI commands that talk to the local daemon over
 * HTTP — `lore doctor`, `lore status` — resolve the same port this file
 * already does, instead of each keeping its own hardcoded-3847 copy that
 * silently misses a daemon started with a non-default `LORE_PORT`.
 */
export const DEFAULT_PORT = Number(process.env['LORE_PORT'] ?? 3847);

/**
 * True when something answers the local Lore HTTP daemon's health
 * endpoint. False on connect-refused / timeout — the typical "daemon
 * is down" case.
 *
 * NOTE: this only proves *some* process answers on `port` — it says
 * nothing about which `LORE_HOME` that process is serving. Any preflight
 * that means to REFUSE a CLI operation because "our" store is held by a
 * daemon must use {@link isDaemonServingHome} instead; this raw signal is
 * kept for callers (and existing tests) that only need "is anything
 * there", plus the topology-check branch-selection in doctor.ts, which
 * already reports a mismatch honestly via its own probeJson status code
 * rather than refusing outright.
 */
export async function isDaemonUp(timeoutMs = 800, port = DEFAULT_PORT): Promise<boolean> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: ac.signal,
        });
        return res.ok || res.status === 401 || res.status === 403;
    } catch {
        return false;
    } finally {
        clearTimeout(t);
    }
}

/** Result of {@link isDaemonServingHome}. */
export interface DaemonHomeProbe {
    /**
     * True only when a live daemon on `port`, presented with a Bearer built
     * from THIS home's own `auth.token`, confirmed via its `/api/health`
     * `loreHome` field that it is serving this exact directory. Only this
     * case should ever refuse a CLI operation — anything else is either no
     * daemon at all, or a daemon that happens to answer the same port
     * number for a completely different `LORE_HOME`.
     */
    servesHome: boolean;
    /**
     * True when something answered `/api/health` at all, but it was not
     * confirmed to be serving this home (wrong/rejected token, or a
     * different `loreHome` in its authenticated body). Lets a caller whose
     * later direct-open still hits a real file lock report an honest
     * message instead of the generic "held by a running Lore process" one —
     * see {@link DaemonHomeProbe.credentialRejected} for which honest
     * message applies.
     */
    otherDaemonReachable: boolean;
    /**
     * Round E3, 2026-09-03 (finding: `otherDaemonReachable` collapsed two
     * different situations into one message — "reports a different home"
     * was printed even when the daemon never told us WHOSE home it serves,
     * because it rejected our credential outright). True when
     * `otherDaemonReachable` is true because the daemon returned 401/403,
     * or a 200 whose body carried no `loreHome` (our Bearer wasn't accepted
     * as valid) — in both cases we have no evidence about which home it
     * serves, only that OUR token didn't work. False when
     * `otherDaemonReachable` is true because the daemon DID authenticate us
     * and reported a `loreHome` that resolves elsewhere — a genuinely
     * different home. Undefined when `otherDaemonReachable` is false (no
     * daemon reachable at all).
     */
    credentialRejected?: boolean;
}

function realpathOrResolve(p: string): string {
    try {
        return fs.realpathSync(p);
    } catch {
        return path.resolve(p);
    }
}

/**
 * True only when the daemon on `port` is demonstrably serving `home` —
 * not merely "something answers this port". Finding (round E2, 2026-09-03):
 * `isDaemonUp()` alone made every CLI preflight refuse whenever ANY process
 * answered 200 on `/api/health` at `LORE_PORT`, with no check that the
 * answering daemon was serving THIS `LORE_HOME` — so `lore init` on a
 * brand-new home was refused by an unrelated daemon on the same port
 * number, and any command against an already-initialized-but-unlocked home
 * was refused the same way.
 *
 * The fix piggybacks on infrastructure that already exists: a daemon writes
 * `<its LORE_HOME>/auth.token` at boot (security/authToken.ts), and
 * `/api/health`'s FULL body (Bearer-authenticated only — see
 * mcp/http/routes/diagnostic/health.ts, FINDING 4 2026-09-03) carries its
 * effective `loreHome`.
 *
 *   1. No `auth.token` at `home` → no daemon has ever booted against this
 *      exact home, so nothing can be serving it — skip the network probe
 *      entirely and report `{ servesHome: false, otherDaemonReachable:
 *      false }`. The caller's own direct-open + lock probe (real disk lock,
 *      not a port guess) is what actually protects the store from a real
 *      holder in this case.
 *   2. `auth.token` exists → GET `/api/health` with that token as Bearer.
 *      - 200 with a `loreHome` that resolves (realpath) to the same
 *        directory as `home` → `servesHome: true` (refuse).
 *      - 401/403, or 200 with no `loreHome` (an anonymous-shaped body —
 *        the answering daemon didn't recognize our token as valid) or a
 *        `loreHome` that resolves elsewhere → the answering daemon is not
 *        ours: `servesHome: false, otherDaemonReachable: true`.
 *      - unreachable / timeout / any other error → `{ false, false }`,
 *        same as "no daemon at all".
 */
export async function isDaemonServingHome(
    home: string,
    timeoutMs = 800,
    port = DEFAULT_PORT,
): Promise<DaemonHomeProbe> {
    const tokenPath = path.join(home, 'auth.token');
    let token: string;
    try {
        token = fs.readFileSync(tokenPath, 'utf-8').trim();
    } catch {
        return { servesHome: false, otherDaemonReachable: false };
    }
    if (!token) return { servesHome: false, otherDaemonReachable: false };

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: ac.signal,
            headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401 || res.status === 403) {
            return { servesHome: false, otherDaemonReachable: true, credentialRejected: true };
        }
        if (!res.ok) {
            return { servesHome: false, otherDaemonReachable: false };
        }
        const body = (await res.json().catch(() => null)) as { loreHome?: string } | null;
        const daemonHome = body?.loreHome;
        if (!daemonHome) {
            // Anonymous-shaped body despite sending a Bearer — the
            // answering daemon didn't accept our token as valid, so it
            // cannot be confirmed as serving this home.
            return { servesHome: false, otherDaemonReachable: true, credentialRejected: true };
        }
        const same = realpathOrResolve(daemonHome) === realpathOrResolve(home);
        return { servesHome: same, otherDaemonReachable: !same };
    } catch {
        return { servesHome: false, otherDaemonReachable: false };
    } finally {
        clearTimeout(t);
    }
}

/**
 * Standard refuse message printed to stderr when the daemon is up.
 * Uses `launchctl bootout` because that's the deploy pattern Rafi's
 * setup uses (`com.groundfloor.lore` launchd service). The dispatcher
 * exits non-zero after printing.
 */
export function daemonRefuseMessage(command: string): string {
    return [
        `${command}: daemon is running and would conflict with this CLI operation.`,
        '',
        'Stop the daemon first, then retry:',
        '',
        '  launchctl bootout gui/$(id -u)/com.groundfloor.lore',
        '',
        'After the operation completes:',
        '',
        '  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.groundfloor.lore.plist',
        '',
        'Tests / one-shots can bypass this gate with --force (use only when you',
        'are CERTAIN no other process is writing to the same workspace).',
    ].join('\n');
}

/**
 * Refuse message for `lore compact` / `lore maintain` when
 * {@link isDaemonServingHome} reports `otherDaemonReachable: true` — a
 * process on `port` answered but did NOT confirm it is serving this exact
 * `LORE_HOME` (a stale/rotated/corrupted `auth.token`, a case-mismatched
 * home, or a genuinely different Lore install on the same port number all
 * land here as `servesHome: false`).
 *
 * Finding (round E3, 2026-09-03, high): both commands treated
 * `servesHome === false` as "safe to proceed" with no other check, so a
 * stale CLI token that made a LIVE same-home daemon's health probe come
 * back 401 let `compactCommand` run `table.optimize()` straight into a
 * LanceDB table the daemon was concurrently writing to — reproduced with
 * real corruption (`lance error: Not found: …_deletions/….arrow`) in
 * qa/B5-round3/attack1b-compact-no-fallback.mts. `servesHome: false` here
 * is "not PROVEN to be ours", not "proven safe" — treat it as unknown and
 * refuse unless the operator overrides with `--force`, exactly like a
 * confirmed same-home daemon does. This is the ONLY case that should ever
 * require `--force` to proceed past; when no daemon answers on `port` at
 * all (`otherDaemonReachable: false`), the second-layer
 * {@link probeSurrealLock}-style disk check remains the real safety net and
 * this message is never shown.
 */
export function otherDaemonRefuseMessage(command: string, port = DEFAULT_PORT): string {
    return [
        `${command}: a Lore process on port ${port} rejected this CLI token — it may hold this store.`,
        '',
        'This CLI could not confirm whether that process is serving the same LORE_HOME, so',
        'proceeding could race a live writer and corrupt the store.',
        '',
        'Regenerate the token or stop the process on that port, then retry, or pass --force',
        'if you are CERTAIN nothing else is writing to this workspace.',
    ].join('\n');
}
