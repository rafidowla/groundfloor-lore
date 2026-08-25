/**
 * migrateWorkspaceToWorkspaceShared.ts — daemon preflight helpers
 * shared by `lore migrate workspace-to-workspace` and `lore compact`.
 *
 * Both commands touch a workspace's stores from outside the daemon. `lore
 * compact` compacts the LanceDB tables under `.lore/lancedb/` (its former
 * Kùzu half was removed with the Kùzu engine, 2026-08-21); `lore migrate
 * workspace-to-workspace` opens the graph store each side declares. The
 * stores are single-writer at the file level — surrealkv by directory lock,
 * LanceDB by table lock — so a concurrent CLI write while the daemon holds
 * the same `.lore/` would corrupt it or fail to open. Both commands
 * therefore probe `http://127.0.0.1:<LORE_PORT||3847>/api/health` and
 * refuse on a live response.
 */

const DEFAULT_PORT = Number(process.env['LORE_PORT'] ?? 3847);

/**
 * True when something answers the local Lore HTTP daemon's health
 * endpoint. False on connect-refused / timeout — the typical "daemon
 * is down" case.
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
