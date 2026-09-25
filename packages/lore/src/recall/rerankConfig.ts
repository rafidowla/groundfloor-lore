/**
 * rerankConfig.ts — D8 (Lore 3.23): config resolution for the optional
 * local cross-encoder re-rank stage. See DESIGN-3.23.md §3.2 for the base
 * precedence table and $SP/SECURITY-D8.md for the D8d default-flip owner
 * decisions this file now implements.
 *
 * D8d (2026-09-25) flips the feature to ON BY DEFAULT and adds a
 * `setHostRerankDefault()` tier (the `createLore({recallRerank})` option).
 * Full `enabled` precedence, highest to lowest:
 *
 *   1. Per-query `rerank:false`                → OFF, no meta (byte-identical
 *                                                  to pre-D8 output).
 *   2. Workspace `recallRerank.enabled:false`   → OFF, AUTHORITATIVE — beats
 *                                                  even a per-query
 *                                                  `rerank:true`.
 *                                                  `_meta.rerank =
 *                                                  {applied:false,
 *                                                  reason:'workspace_disabled'}`.
 *   3. Per-query `rerank:true`                  → ON.
 *   4. Workspace `recallRerank.enabled:true`    → ON.
 *   5. Host default (`setHostRerankDefault`,
 *      i.e. `createLore({recallRerank})`)       → whatever it says.
 *   6. Env `LORE_RECALL_RERANK`                 → whatever it says.
 *   7. Default                                  → ON.
 *
 * This is checked in exactly that order below — critically, workspace-off
 * (tier 2) is evaluated BEFORE per-query-true (tier 3), which is what makes
 * it authoritative; a plain per-query-false (tier 1) short-circuits before
 * either.
 *
 *   - `model` / `k` / `margin`: workspace > env > default. `model` is also
 *                           validated (`validateRerankModelId`) — an invalid
 *                           configured id forces `enabled:false` with
 *                           `disabledReason:'invalid_model'`, never a thrown
 *                           error on the retrieve() hot path.
 *   - `dtype`:              fixed at `'q8'` unless `LORE_RECALL_RERANK_DTYPE`
 *                           overrides it with a value from `VALID_DTYPES`
 *                           (no per-call or per-workspace dtype surface —
 *                           see §3.2's closing note on English-only default
 *                           vs multilingual operators). An invalid env value
 *                           is ignored (falls back to the default, logged),
 *                           never thrown.
 *   - `timeoutMs`:          env override (clamped to
 *                           `[RERANK_TIMEOUT_MS_MIN, RERANK_TIMEOUT_MS_MAX]`),
 *                           else default. No per-workspace surface (not in
 *                           the §3.2 config table).
 *
 * `resolveRerankConfig` is the ONLY hot-path entry point (called from
 * `rerankStage.ts`'s `applyRerankStageIfEnabled`, which `retrieve.ts` calls
 * on every query). It therefore reads the workspace registry the same
 * read-only, non-throwing, no-bootstrap-write way
 * `core/supersessionPolicy.ts`'s `resolveSupersessionContext` reads
 * `getWorkspaceSupersessionPolicy` (D5 round 4 fix, 2026-09-23): probe with
 * `loadWorkspacesIfPresent` first — no control file, or no matching entry,
 * resolves to "policy absent", with NO side effect. `loadWorkspaces()`
 * (used only by the exported getter/setter below, mirroring
 * `getWorkspaceVocabPolicy`/`setWorkspaceVocabPolicy`) BOOTSTRAP-WRITES a
 * `workspaces.json` when none exists, and throws on an unregistered
 * workspace name — both are fine for an explicit CLI-driven read/write, but
 * would be a surprising side effect (or a hard failure) on every retrieve()
 * call against a workspace that simply hasn't been registered yet (e.g. a
 * raw graph/verbatim pair opened directly in a test, same case D5 already
 * had to fix for its own write-time policy read).
 */

import { loadWorkspaces, loadWorkspacesIfPresent, writeControl } from '../config/workspaces.js';
import { loreHome } from '../config/loreHome.js';
import type { RerankDtype } from '../providers/localRerankProvider.js';
import { validateRerankModelId } from '../providers/rerankModelId.js';

const VALID_DTYPES: readonly RerankDtype[] = ['fp32', 'fp16', 'q8', 'q4'];

/** F6: `timeoutMs` clamp bounds — an operator-set env value outside this
 *  range is clamped rather than trusted verbatim (too low starves every
 *  rerank call into `reason:'timeout'`; too high defeats the point of
 *  having a query-time bound at all). */
export const RERANK_TIMEOUT_MS_MIN = 100;
export const RERANK_TIMEOUT_MS_MAX = 30_000;

/** Default cross-encoder model — English-only. Non-English workspaces
 *  should set a multilingual cross-encoder id via `WorkspaceRecallRerank.model`
 *  (availability of a Transformers.js ONNX export must be verified per
 *  model — D8 does not hard-code one; see DESIGN-3.23.md §3.2). */
export const DEFAULT_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
export const DEFAULT_RERANK_K = 10;
export const DEFAULT_RERANK_MARGIN = 1.0;
export const DEFAULT_RERANK_TIMEOUT_MS = 3000;
export const DEFAULT_RERANK_DTYPE: RerankDtype = 'q8';

export const RERANK_K_MIN = 2;
export const RERANK_K_MAX = 20;

/**
 * Per-workspace re-rank policy, stored at `WorkspaceEntry.recallRerank`
 * (config/workspaces.ts). Absent = no workspace override (falls through to
 * env/default for every field). `enabled: undefined` on a present policy
 * object is not a valid on-disk shape — the setter always writes an
 * explicit boolean — but the type allows it so `resolveRerankConfig` can
 * share one shape for "policy object present but a given field unset".
 */
export interface WorkspaceRecallRerank {
    enabled: boolean;
    model?: string;
    k?: number;
    margin?: number;
}

export interface RerankConfig {
    enabled: boolean;
    model: string;
    dtype: RerankDtype;
    k: number;
    margin: number;
    timeoutMs: number;
    /** Set only when `enabled:false` for a reason more specific than a plain
     *  per-query/workspace/host/env "off" signal (those stay `undefined` —
     *  no meta surfaced at all, byte-identical output). `rerankStage.ts`'s
     *  `applyRerankStageIfEnabled` reads this to decide whether to surface
     *  `_meta.rerank` on an otherwise-disabled call. */
    disabledReason?: 'workspace_disabled' | 'invalid_model';
}

/**
 * Host-level default for `enabled` — set once by `createLore({recallRerank})`
 * (mcp/server.ts). Sits between workspace policy and the env var in the
 * precedence chain (see this file's header). `undefined` = "no host
 * opinion", the state every process starts in. Process-global by design,
 * same pattern as `config/loreHome.ts`'s `loreHome()` — `resolveRerankConfig`
 * is only ever reached via the process-global `loreHome()` today (no
 * per-instance `dataDir` threading), so a per-instance host default would be
 * inconsistent with how every other tier here already resolves.
 */
let hostRerankDefault: boolean | undefined;

/** Set (or clear, with `undefined`) the host-level default from
 *  `createLore({recallRerank})`. Test-only reset: call with `undefined`. */
export function setHostRerankDefault(enabled: boolean | undefined): void {
    hostRerankDefault = enabled;
}

/** Test-only: read the current host default without going through a full
 *  `resolveRerankConfig` call. */
export function getHostRerankDefaultForTests(): boolean | undefined {
    return hostRerankDefault;
}

function parseBoolEnv(name: string): boolean | undefined {
    const raw = process.env[name];
    if (raw === undefined) return undefined;
    const v = raw.trim().toLowerCase();
    if (v === '') return undefined;
    if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
    if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
    return undefined;
}

function parseNumEnv(name: string): number | undefined {
    const raw = process.env[name];
    if (!raw || raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

function clampInt(n: number, min: number, max: number): number {
    const floored = Math.floor(n);
    return Math.min(Math.max(floored, min), max);
}

/**
 * Read-only, side-effect-free probe for a workspace's `recallRerank`
 * policy. Returns `undefined` when there is no control file, no matching
 * workspace entry, or the control file is unreadable/corrupt (logged, not
 * thrown) — see this file's header for why this must never bootstrap-write
 * or throw on the retrieve() hot path.
 */
function readWorkspaceRecallRerankSafe(workspaceName: string | undefined, home: string): WorkspaceRecallRerank | undefined {
    if (!workspaceName) return undefined;
    try {
        const file = loadWorkspacesIfPresent(home);
        if (!file) return undefined;
        const entry = file.workspaces.find((w) => w.name === workspaceName);
        return entry?.recallRerank;
    } catch (err) {
        // Narrow, logged fail-open — mirrors supersessionPolicy.ts's
        // identical catch around getWorkspaceSupersessionPolicy: a corrupt
        // or unreadable control file must not turn re-rank config
        // resolution into a hard retrieve() failure.
        // N15/F9: truncate the same way rerankStage.ts does before logging —
        // an unreadable/corrupt control file's error message can embed the
        // LORE_HOME path or other local detail and must not be logged
        // verbatim.
        const rawMsg = err instanceof Error ? err.message : String(err);
        const msg = rawMsg.length > 300 ? `${rawMsg.slice(0, 300)}…` : rawMsg;
        console.error(`[rerankConfig] workspace policy unreadable for "${workspaceName}" — using env/default: ${msg}`);
        return undefined;
    }
}

/**
 * Resolve the effective re-rank config for one retrieve() call. `perCall`
 * is `RetrieveOptions.rerank` (undefined = "no per-call opinion").
 * `workspaceName` is the workspace the retrieve() call is scoped to
 * (undefined for callers with no workspace context, e.g. some tests).
 */
export function resolveRerankConfig(
    perCall: boolean | undefined,
    workspaceName: string | undefined,
    home: string = loreHome(),
): RerankConfig {
    const workspacePolicy = readWorkspaceRecallRerankSafe(workspaceName, home);
    const envEnabled = parseBoolEnv('LORE_RECALL_RERANK');

    // See this file's header for the full precedence table + rationale.
    // Order matters: workspace-off (tier 2) is checked before per-query-true
    // (tier 3) so it can override it; per-query-false (tier 1) short-circuits
    // before either.
    let enabled: boolean;
    let disabledReason: RerankConfig['disabledReason'];
    if (perCall === false) {
        enabled = false;
    } else if (workspacePolicy?.enabled === false) {
        enabled = false;
        // B1 fix: only surface `_meta.rerank` when the workspace-off
        // actually overrode an explicit per-query `rerank:true` — a plain
        // workspace-off with no per-call opinion must stay byte-identical
        // to pre-D8 output (owner decision 1), i.e. no disabledReason, no
        // meta at all (see applyRerankStageIfEnabled's branch on this).
        if (perCall === true) disabledReason = 'workspace_disabled';
    } else if (perCall === true) {
        enabled = true;
    } else if (workspacePolicy?.enabled === true) {
        enabled = true;
    } else if (hostRerankDefault !== undefined) {
        enabled = hostRerankDefault;
    } else if (envEnabled !== undefined) {
        enabled = envEnabled;
    } else {
        enabled = true; // D8d: default ON.
    }

    const model = workspacePolicy?.model
        ?? process.env['LORE_RECALL_RERANK_MODEL']
        ?? DEFAULT_RERANK_MODEL;

    // F3: an invalid configured model id disables re-rank outright rather
    // than reaching the provider with an unvalidated string — fail open,
    // never thrown, on the retrieve() hot path.
    if (enabled && !validateRerankModelId(model)) {
        enabled = false;
        disabledReason = 'invalid_model';
    }

    // N14: a hand-edited workspaces.json can carry a non-numeric `k` (e.g.
    // "abc") — treat that the same as "field absent" and fall through to
    // env/default, rather than letting it flow into clampInt() as NaN
    // (Math.floor(NaN) stays NaN through both Math.max/Math.min, so `k`
    // would silently become NaN and every rerank call would report
    // `applied:true` with no actual reorder).
    const workspaceK = typeof workspacePolicy?.k === 'number' && Number.isFinite(workspacePolicy.k)
        ? workspacePolicy.k
        : undefined;
    const rawK = workspaceK
        ?? parseNumEnv('LORE_RECALL_RERANK_K')
        ?? DEFAULT_RERANK_K;
    const k = clampInt(rawK, RERANK_K_MIN, RERANK_K_MAX);

    const rawMargin = workspacePolicy?.margin
        ?? parseNumEnv('LORE_RECALL_RERANK_MARGIN')
        ?? DEFAULT_RERANK_MARGIN;
    const margin = Number.isFinite(rawMargin) ? rawMargin : DEFAULT_RERANK_MARGIN;

    // F6: allow-list the dtype env override; an unrecognized value falls
    // back to the default instead of being trusted verbatim (it would
    // otherwise flow straight into `from_pretrained({dtype})`).
    const dtypeRaw = process.env['LORE_RECALL_RERANK_DTYPE'];
    let dtype: RerankDtype = DEFAULT_RERANK_DTYPE;
    if (dtypeRaw !== undefined && dtypeRaw.trim() !== '') {
        if ((VALID_DTYPES as readonly string[]).includes(dtypeRaw)) {
            dtype = dtypeRaw as RerankDtype;
        } else {
            console.error(`[rerankConfig] LORE_RECALL_RERANK_DTYPE="${dtypeRaw}" is not one of ${VALID_DTYPES.join(', ')} — using default "${DEFAULT_RERANK_DTYPE}"`);
        }
    }

    // F6: clamp an operator-set timeout into a sane range instead of
    // trusting it verbatim (too low starves every call into
    // reason:'timeout'; too high defeats the point of a query-time bound).
    const rawTimeoutMs = parseNumEnv('LORE_RECALL_RERANK_TIMEOUT_MS') ?? DEFAULT_RERANK_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(rawTimeoutMs, RERANK_TIMEOUT_MS_MIN), RERANK_TIMEOUT_MS_MAX);

    return { enabled, model, dtype, k, margin, timeoutMs, ...(disabledReason ? { disabledReason } : {}) };
}

/**
 * Explicit accessor mirroring `getWorkspaceVocabPolicy` — CLI-facing
 * (`lore workspace get-rerank`, D8b). Unlike `resolveRerankConfig`'s
 * internal probe, this goes through `loadWorkspaces()` (bootstraps a
 * control file if none exists) and throws on an unknown workspace name, so
 * an operator typo surfaces as an error instead of a silently-absent
 * policy. Returns `{ enabled: false }` when the entry has no explicit
 * policy (back-compat default).
 */
export function getWorkspaceRecallRerank(name: string, home: string = loreHome()): WorkspaceRecallRerank {
    const file = loadWorkspaces(home);
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) throw new Error(`Unknown workspace "${name}"`);
    const policy = entry.recallRerank;
    if (!policy) return { enabled: false };
    return {
        enabled: policy.enabled === true,
        ...(policy.model ? { model: policy.model } : {}),
        ...(typeof policy.k === 'number' ? { k: policy.k } : {}),
        ...(typeof policy.margin === 'number' ? { margin: policy.margin } : {}),
    };
}

/**
 * Explicit setter mirroring `setWorkspaceVocabPolicy` — CLI-facing (D8b).
 * Replaces any prior policy in full. Pass `null` to clear (back to
 * "absent" = env/default precedence only).
 */
export function setWorkspaceRecallRerank(name: string, policy: WorkspaceRecallRerank | null, home: string = loreHome()): WorkspaceRecallRerank | null {
    const file = loadWorkspaces(home);
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) throw new Error(`Unknown workspace "${name}"`);
    if (policy === null) {
        delete entry.recallRerank;
        writeControl(file, home);
        return null;
    }
    if (typeof policy.enabled !== 'boolean') {
        throw new Error('Invalid recallRerank.enabled (expected boolean)');
    }
    if (policy.k !== undefined && (typeof policy.k !== 'number' || policy.k < RERANK_K_MIN || policy.k > RERANK_K_MAX)) {
        throw new Error(`Invalid recallRerank.k (expected a number between ${RERANK_K_MIN} and ${RERANK_K_MAX})`);
    }
    if (policy.margin !== undefined && (typeof policy.margin !== 'number' || !Number.isFinite(policy.margin))) {
        throw new Error('Invalid recallRerank.margin (expected a finite number)');
    }
    if (policy.model !== undefined && !validateRerankModelId(policy.model)) {
        throw new Error(`Invalid recallRerank.model "${policy.model}" (expected an "org/name"-shaped HF model id)`);
    }
    entry.recallRerank = {
        enabled: policy.enabled,
        ...(policy.model ? { model: policy.model } : {}),
        ...(typeof policy.k === 'number' ? { k: policy.k } : {}),
        ...(typeof policy.margin === 'number' ? { margin: policy.margin } : {}),
    };
    writeControl(file, home);
    return entry.recallRerank;
}
