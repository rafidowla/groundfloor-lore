/**
 * modelServer/config.ts — env-var configuration for the model server
 * process itself (D9 §5.4/§5.9). Every name here is allowlisted in
 * `security/envScrub.ts` and documented in `docs/CONFIGURATION.md`
 * (§2.7 Shared model server) — see `test/nw2a-envscrub-allowlist-completeness-unit.ts`
 * and `test/sw24-config-reference-unit.ts`.
 *
 * Read once at module load, matching the daemon's existing convention
 * (e.g. `logger.ts`'s `LORE_LOG_LEVEL`) — the server is a short-lived,
 * single-purpose process, not something that reconfigures itself at
 * runtime.
 */

/** Duplicated (not shared) — see localEmbeddingProvider.ts / localRerankProvider.ts's
 *  identical `parseEnvInt` and this repo's "no misc.ts/utils.ts" file-size rule. */
function parseEnvInt(name: string, fallback: number, min: number): number {
    const raw = process.env[name];
    if (!raw || raw.trim() === '') return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
}

/** No client connected, nothing in flight, for this long -> clean exit.
 *  `0` disables idle-exit entirely (server runs until SIGTERM/shutdown). */
export const MODEL_SERVER_IDLE_EXIT_MS = parseEnvInt('LORE_MODEL_SERVER_IDLE_EXIT_MS', 60_000, 0);

/** Nobody ever connects within this long after a successful `listen()` ->
 *  clean exit (guards against a spawned server nobody ended up needing,
 *  e.g. the spawning host crashed before its first request). */
export const MODEL_SERVER_BOOTSTRAP_TIMEOUT_MS = parseEnvInt('LORE_MODEL_SERVER_BOOTSTRAP_TIMEOUT_MS', 30_000, 0);

/** Max simultaneously connected clients; a connect over this is refused. */
export const MODEL_SERVER_MAX_CLIENTS = parseEnvInt('LORE_MODEL_SERVER_MAX_CLIENTS', 64, 1);

/** Per-text character cap on any single `embed`/`rerank` string — a
 *  protective ceiling against a pathological single request (mirrors the
 *  existing per-text cap semantics in providers/openAICompatEmbeddingProvider.ts's
 *  `LORE_EMBEDDER_CHAR_LIMIT`, but scoped to this server: an operator who
 *  wants a different cap for server-mediated calls doesn't have to change
 *  the OpenAI-compat provider's own limit). Violating requests get a
 *  `too_large` typed error, connection stays open. */
export const MODEL_SERVER_TEXT_CHAR_LIMIT = parseEnvInt('LORE_MODEL_SERVER_TEXT_CHAR_LIMIT', 200_000, 1);

/** Rotate `model-server.log` once it reaches this many bytes. */
export const MODEL_SERVER_LOG_MAX_BYTES = parseEnvInt('LORE_MODEL_SERVER_LOG_MAX_BYTES', 10_000_000, 1024);

/** Retained rotated log files (`.1` .. `.N`), oldest dropped past this. */
export const MODEL_SERVER_LOG_MAX_FILES = parseEnvInt('LORE_MODEL_SERVER_LOG_MAX_FILES', 3, 1);

/** Max queued (not-yet-dispatched) embed requests per connected client —
 *  bounds server memory if one client fires far more requests than the
 *  single-flight embed queue can drain. Over this, a NEW request from that
 *  client gets an immediate `busy` error instead of queueing. */
export const MODEL_SERVER_QUEUE_MAX_PER_CLIENT = parseEnvInt('LORE_MODEL_SERVER_QUEUE_MAX_PER_CLIENT', 256, 1);

/** Concurrent re-rank score runs in the server. In-process each host gets
 *  `LORE_RECALL_RERANK_MAX_CONCURRENT` (default 2) slots of its own; the
 *  server serves every host from one pool, so 2 made concurrent hosts fail
 *  open with `busy` (2.5% of recalls with 4 hosts, docs/perf/
 *  D9-shared-models-RESULTS.md). Precedence: this var, else an explicitly set
 *  `LORE_RECALL_RERANK_MAX_CONCURRENT`, else 4. */
export const MODEL_SERVER_RERANK_MAX_CONCURRENT = parseEnvInt(
    'LORE_MODEL_SERVER_RERANK_MAX_CONCURRENT',
    parseEnvInt('LORE_RECALL_RERANK_MAX_CONCURRENT', 4, 1),
    1,
);
