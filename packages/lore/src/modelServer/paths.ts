/**
 * modelServer/paths.ts — key derivation and filesystem layout for the
 * shared local model server (D9 §5.1/§5.8).
 *
 * Keying: one server per unique (LORE_HOME, protocol major, transformers
 * version, onnxruntime-node version) combination. Different hosts on the
 * same machine sharing the same `LORE_HOME` and the same installed runtime
 * versions connect to the SAME server; a host on a different `LORE_HOME`,
 * or one with a different transformers/onnxruntime-node version installed
 * (e.g. a dev checkout mid-upgrade), gets its own — this is what keeps a
 * version skew from ever mixing incompatible ONNX sessions in one process.
 *
 * Layout under `<LORE_HOME>/run/model-server-<key>/`:
 *   server.sock   — unix domain socket (or the tmpdir fallback below)
 *   token         — 0600 hex auth token, written atomically before listen
 *   server.pid    — pidfile, written after a successful listen
 *   server.lock   — spawn/ownership lock: names the spawning host's pid
 *                   while a spawn is in progress, then the server's own pid
 *                   for its lifetime (spawnLock.ts)
 *   server.lock.guard — momentary mutex for lock read-modify-writes
 * Every path is built from `resolveHome(loreHome)`, the same material as
 * the key.
 * Logging is NOT per-key: `<LORE_HOME>/logs/model-server.log` is shared
 * across every key that ever ran on this LORE_HOME, so an operator has one
 * file to tail regardless of which runtime combination is currently active.
 *
 * `SERVER_ENV_ALLOWLIST` is exported for slice C2 (the spawning host
 * client) — the subset of env vars a spawned server process should inherit.
 * Deliberately NOT the full envScrub allowlist: the server needs runtime +
 * model-loading knobs, nothing about MCP/sync/dataplane/etc.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { PROTOCOL_VERSION } from './protocol.js';

const require = createRequire(import.meta.url);

/** Read a package's installed version from its own package.json, resolved
 *  via node_modules (not assumed relative to cwd). Returns 'unknown' rather
 *  than throwing — an unresolvable version still yields a valid (if less
 *  precise) server key instead of crashing startup. */
function pkgVersion(pkgName: string): string {
    try {
        const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
        const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { version?: unknown };
        return typeof parsed.version === 'string' ? parsed.version : 'unknown';
    } catch {
        return 'unknown';
    }
}

export const TRANSFORMERS_VERSION = pkgVersion('@huggingface/transformers');
export const ONNXRUNTIME_NODE_VERSION = pkgVersion('onnxruntime-node');

/**
 * resolveHome — the canonical form of `loreHome` every path and the key are
 * built from: `realpath` when it exists, else `path.resolve`. Using the same
 * material for the key AND the run dir/socket means two spellings of one
 * directory (`/tmp` vs `/private/tmp`, a symlink, `..` segments) can never
 * split one server's files across two directories (review blocker A).
 */
export function resolveHome(loreHome: string): string {
    try {
        return fs.realpathSync(loreHome);
    } catch {
        return path.resolve(loreHome);
    }
}

/**
 * serverKey — short hex digest identifying one (loreHome, protocol major,
 * transformers version, onnxruntime-node version) combination, over
 * `resolveHome(loreHome)` so two paths to the same directory collapse to
 * one key rather than spawning duplicate servers.
 */
export function serverKey(loreHome: string): string {
    const material = [resolveHome(loreHome), String(PROTOCOL_VERSION), TRANSFORMERS_VERSION, ONNXRUNTIME_NODE_VERSION].join('|');
    return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export function runDir(loreHome: string, key: string): string {
    return path.join(resolveHome(loreHome), 'run', `model-server-${key}`);
}

/** POSIX `sockaddr_un.sun_path` is 104 bytes on macOS/BSD (108 on Linux) —
 *  use the tighter macOS bound everywhere since this targets Darwin, and
 *  leave one byte of headroom for the NUL terminator libuv appends. */
const SUN_PATH_MAX_BYTES = 104;

function primarySocketPath(loreHome: string, key: string): string {
    return path.join(runDir(loreHome, key), 'server.sock');
}

/** Fallback socket location when `loreHome` is deep enough that the
 *  primary path would overflow `sun_path` (common under a temp-dir-nested
 *  test harness or CI worktree). Keyed by uid so two OS users on the same
 *  machine never collide in world-writable `os.tmpdir()`. */
function fallbackSocketPath(key: string): string {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    return path.join(os.tmpdir(), `lore-${uid}`, `${key}.sock`);
}

/**
 * socketPath — the unix socket path to bind/connect for `key` under
 * `loreHome`, falling back to a short `os.tmpdir()`-rooted path when the
 * natural path would exceed the platform's `sun_path` limit.
 */
export function socketPath(loreHome: string, key: string): string {
    const primary = primarySocketPath(loreHome, key);
    if (Buffer.byteLength(primary, 'utf8') < SUN_PATH_MAX_BYTES) return primary;
    return fallbackSocketPath(key);
}

export function tokenPath(loreHome: string, key: string): string {
    return path.join(runDir(loreHome, key), 'token');
}

export function pidPath(loreHome: string, key: string): string {
    return path.join(runDir(loreHome, key), 'server.pid');
}

export function lockPath(loreHome: string, key: string): string {
    return path.join(runDir(loreHome, key), 'server.lock');
}

/** Short-lived mutex around every read-modify-write of `lockPath` (see
 *  spawnLock.ts) — held only for a synchronous critical section. */
export function lockGuardPath(loreHome: string, key: string): string {
    return path.join(runDir(loreHome, key), 'server.lock.guard');
}

/**
 * privateDirProblem — review SF5. The run dir and the socket's directory
 * (which may be the shared `os.tmpdir()/lore-<uid>` fallback) must be a real
 * directory (not a symlink), owned by this uid, with no group/other bits —
 * otherwise another local user could have pre-created it, planted a socket
 * or read the token. Never "fixed up" with chmod: a dir that ever had loose
 * bits may already hold someone else's files. `create` makes it (0700) when
 * missing; otherwise a missing dir is fine — the server creates it. Returns
 * a human-readable reason, or null when safe (or the platform has no uids).
 */
export function privateDirProblem(dir: string, create: boolean): string | null {
    if (create) {
        try {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        } catch (err) {
            return `cannot create ${dir}: ${(err as Error).message}`;
        }
    }
    let st: fs.Stats;
    try {
        st = fs.lstatSync(dir);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !create) return null;
        return `cannot stat ${dir}: ${(err as Error).message}`;
    }
    if (st.isSymbolicLink()) return `${dir} is a symlink`;
    if (!st.isDirectory()) return `${dir} is not a directory`;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid === undefined) return null;
    if (st.uid !== uid) return `${dir} is owned by uid ${st.uid}, not ${uid}`;
    if ((st.mode & 0o077) !== 0) return `${dir} has mode ${(st.mode & 0o777).toString(8)}, expected no group/other access`;
    return null;
}

/** Shared across every key on this `loreHome` — see file header. */
export function logPath(loreHome: string): string {
    return path.join(loreHome, 'logs', 'model-server.log');
}

/**
 * SERVER_ENV_ALLOWLIST — env vars a spawning host (slice C2) should pass
 * through to a spawned model-server child. A strict subset of
 * `security/envScrub.ts`'s daemon allowlist: only what the server needs to
 * find its data root, run under the right Node/runtime settings, and load
 * models the way the spawning host expects (device/dtype overrides).
 */
export const SERVER_ENV_ALLOWLIST: readonly string[] = [
    // POSIX / Node essentials — the server is a normal Node child process.
    // NODE_OPTIONS / NODE_PATH / SHELL are deliberately absent (review SF7):
    // one host's `NODE_OPTIONS=--inspect` would otherwise give the process
    // every host shares a TCP debug port, breaking D9's "no TCP" rule.
    'HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'TEMP', 'TMP',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
    'NODE_ENV',

    // Data root — determines the key (see serverKey above) and every path.
    'LORE_HOME',

    // Logging.
    'LORE_LOG_LEVEL',

    // Model-loading knobs the embed/rerank providers themselves read.
    'LORE_LOCAL_EMBEDDING_DEVICE',
    'LORE_LOCAL_EMBEDDING_DTYPE',
    'LORE_LOCAL_EMBEDDING_MODEL',
    'LORE_LOCAL_EMBEDDING_DIM',
    'LORE_MODELS_OFFLINE',
    'LORE_EMBED_IDLE_UNLOAD_MS',
    'LORE_RECALL_RERANK_IDLE_UNLOAD_MS',
    'LORE_RECALL_RERANK_MAX_CACHED_MODELS',
    'LORE_RECALL_RERANK_MAX_CONCURRENT',
    'LORE_EMBED_MEM_PCT',
    'LORE_EMBED_MEM_WAIT_MS',

    // Model-server-own knobs (config.ts).
    'LORE_MODEL_SERVER_IDLE_EXIT_MS',
    'LORE_MODEL_SERVER_BOOTSTRAP_TIMEOUT_MS',
    'LORE_MODEL_SERVER_MAX_CLIENTS',
    'LORE_MODEL_SERVER_TEXT_CHAR_LIMIT',
    'LORE_MODEL_SERVER_RERANK_MAX_CONCURRENT',
    'LORE_MODEL_SERVER_LOG_MAX_BYTES',
    'LORE_MODEL_SERVER_LOG_MAX_FILES',
    'LORE_MODEL_SERVER_QUEUE_MAX_PER_CLIENT',
];

/**
 * buildServerEnv — the exact env object a spawned model-server child is
 * launched with (slice C2's `spawnServerChild`, clientConnection.ts):
 * ONLY the vars named in `SERVER_ENV_ALLOWLIST`, copied from `sourceEnv`
 * when present there, plus `LORE_HOME` force-set to `loreHome` (the
 * machine-level home the server is keyed on — never an embedder's
 * per-instance `dataDir`). Pulled out as a pure function (no `spawn` call,
 * no process side effects) so release-gate tests can assert the allowlist
 * end-to-end without needing to inspect another process's real env, which
 * has no portable equivalent on macOS.
 */
export function buildServerEnv(loreHome: string, sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of SERVER_ENV_ALLOWLIST) {
        const v = sourceEnv[key];
        if (v !== undefined) env[key] = v;
    }
    env.LORE_HOME = loreHome;
    return env;
}
