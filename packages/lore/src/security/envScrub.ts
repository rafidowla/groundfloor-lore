/**
 * envScrub.ts — Parent-environment isolation for spawned Lore processes (S9).
 *
 * Problem: when an IDE (Claude Code, Cursor, Antigravity) spawns Lore as
 * an MCP stdio subprocess, the child inherits the parent's full process
 * environment. That typically includes:
 *   - AWS_SECRET_ACCESS_KEY, AWS_ACCESS_KEY_ID
 *   - GITHUB_TOKEN, GITLAB_TOKEN
 *   - ANTHROPIC_API_KEY, OPENAI_API_KEY  (NOT what we use — we load from
 *     keychain — but present nonetheless)
 *   - arbitrary TOKEN/SECRET/PASSWORD vars from .env files the IDE sourced
 *
 * Lore doesn't need any of those. Having them in process memory:
 *   - widens the blast radius if Lore crashes and stderr dumps env
 *   - widens it further if an external process we don't control inspects env
 *   - increases the damage from any log-redaction gap
 *
 * Fix: scrub to an allowlist at the top of main(), before any module
 * code reads from process.env. The allowlist covers what Lore actually
 * uses + what node needs to run. Everything else is deleted.
 *
 * Called unconditionally (stdio AND http). Helpful even for HTTP daemons
 * launched by launchd — users sometimes run `npx lore serve --http`
 * directly from a shell with a polluted env.
 */

/**
 * Whitelist of environment variables Lore actually needs.
 *
 * Adding new entries requires justification: why does this variable
 * need to reach the Lore process? Prefer reading from ~/.groundfloor/
 * config files over adding envs here.
 */
const ALLOWED_VARS: readonly string[] = [
    // POSIX essentials
    'HOME', 'USER', 'LOGNAME', 'SHELL',
    'PATH', 'TMPDIR', 'TEMP', 'TMP',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'PWD',

    // Node runtime
    'NODE_ENV', 'NODE_OPTIONS', 'NODE_PATH',
    'NVM_BIN', 'NVM_DIR',                       // nvm-managed installs
    'NPM_CONFIG_CACHE', 'NPM_CONFIG_PREFIX',
    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',

    // Lore config
    'LORE_PORT',
    'LORE_LOG_LEVEL',
    'LORE_HOME',                                // 2026-04-28 relocate the entire data tree (default ~/.groundfloor)
    'LORE_WORKSPACE',                           // forces a specific active workspace
    'LORE_DEPLOYMENT_MODE',                     // Q2.1 — pin mode to 'local' or 'cloud'
    'LORE_CACHE_DISABLED',                      // Q1.3 operator killswitch for the read cache
    'LORE_OPENAI_BASE_URL',                     // 2026-05-05 OpenAI-compatible gateway override (e.g. OpenRouter)
    'CLERK_ISSUER',                             // RA2-reaudit2 — cloud-mode Clerk JWT issuer; scrubbing it silently disabled cloud auth (read at dispatcher.ts/operator.ts)

    // rc3 perf/correctness vars — surfaced 2026-05-17 when LanceDB
    // pool-size tuning was silently a no-op (the bug `rc3-env-scrub-
    // allowlist-bug` captures the discovery). Every entry here is
    // READ in the source tree; missing the allowlist means the
    // operator's override is dropped before the consumer ever sees
    // it and the consumer falls back to its default — which the
    // operator has no way to detect without inspecting daemon logs.
    'LORE_CALL_TALLY',                          // per-instance graph operation counter — default ON, '0'/'false' disables (engines/callTally.ts). Allowlisted so an operator can turn it off on the daemon; without this entry the scrub would drop it and the knob would be a silent no-op (rc3-env-scrub-allowlist-bug)
    'LORE_BULK_INGEST_CONCURRENCY',             // max in-flight upserts during bulkIngest — default 16; bounds pool borrows so a large reindex can't overflow the waiter cap — mcp/bulkIngest.ts
    'LORE_LANCE_POOL_SIZE',                     // LanceDB read-table-handle pool size — default 16, clamped [1,32]; perf
    'LORE_POOL_MAX_WAITERS',                    // Max queued acquire() calls before 503 fast-fail — default 200; concurrency
    'LORE_POOL_ACQUIRE_TIMEOUT_MS',             // Max ms a queued acquire may wait before 503 — default 30000; concurrency
    'LORE_EMBEDDER_CHAR_LIMIT',                 // Override the char cap on text sent to OpenAI-compat embed API; correctness (avoids server-side errors on long inputs)

    // rc3 security var — shared-secret token for the MCP socket. If
    // scrubbed, mcp/server.ts's getSharedSecret callback returns
    // undefined and the auth check short-circuits to "no token
    // required". Operators setting this expecting the daemon to be
    // auth-protected would have an unauthenticated daemon and not
    // know — silent security regression.
    'LORE_MCP_AUTH_TOKEN',                      // optional shared-secret for MCP /mcp endpoint

    // rc3 dev-ergonomics vars — silently dropped today, but defaults
    // are safe. Allowlisted so operator overrides actually take
    // effect rather than landing in their default location with no
    // feedback. Lower severity than the perf/security entries above
    // because the default behaviour is correct, just not what was
    // asked for.
    'LORE_ARCHIVE_DIR',                         // archive.ts:122 — relocate the archive-snapshot output dir
    'LORE_OCR_LANGUAGES',                       // extractors/image.ts:152 — Tesseract language packs for image OCR (defaults to 'eng')
    'LORE_WHISPER_BIN',                         // extractors/whisperBin.ts — explicit whisper.cpp CLI path (avoids PATH ambiguity); falls back to PATH lookup

    // v1.1 operator opt-ins — every one of these has to ride through the
    // scrub or it gets silently dropped before the daemon reads it.
    // Found this the hard way during P0 testing — symptom is "the env
    // var is in launchctl print's environment block but the feature
    // never activates". If you add a new LORE_* env var, add it here.
    'LORE_TOOL_TIER',                           // v1.1 deferred #7 — global tool-tier hint
    'LORE_TOOL_SHIM',                           // v1.1.1 P0 — lazy-schema tool catalogue toggle
    'LORE_TOOL_DISPATCH_LOG',                   // v1.1 deferred #6 — set =0 to disable
    'LORE_LOCAL_EMBEDDING_DEVICE',              // v1.1 deferred #3 — ORT EP opt-in (cpu/coreml/webgpu/cuda/auto/gpu)
    'LORE_LOCAL_EMBEDDING_DTYPE',               // local ONNX model quantization (q8 default; fp32 for parity) — providers/localEmbeddingProvider.ts
    'LORE_LOCAL_EMBEDDING_MODEL',               // pre-existing path; allowlisted in case it isn't above
    'LORE_LOCAL_EMBEDDING_DIM',
    // SP-14 — removed three LORE_ATLAS_* entries (LORE_ATLAS_SLIM_TOOLS,
    // LORE_ATLAS_REGISTER_ALL_TOOLS, LORE_ATLAS_REPO_ROOT). They named a
    // specific downstream client (Atlas) + the removed developer plugin's
    // AtlasContext; nothing in Core reads them post-v3.11.0. Dropping them
    // means an operator still setting one gets a clean env-not-recognized
    // scrub rather than a silent no-op.
    'LORE_EMBEDDING_PROVIDER',                  // openai_compat / local / xenova
    'LORE_EMBEDDING_BASE_URL',
    'LORE_EMBEDDING_MODEL',
    'LORE_EMBEDDING_DIMENSION',
    'LORE_EMBEDDING_API_KEY',
    'LORE_OPENAI_API_KEY', 'LORE_OPENAI_BASE_URL', 'LORE_OPENAI_MODEL', 'LORE_OPENAI_DIM',
    'LORE_OLLAMA_HOST', 'LORE_OLLAMA_EMBED_MODEL', 'LORE_OLLAMA_EMBED_DIM',
    'LORE_EVAL_ITERATIONS',                     // eval suite multi-run averaging
    'LORE_SWEEP_DELETE_ORPHANS',                // consistency-sweep opt-in: cascade-delete orphan vectors (default observe-only)

    // 2026-06-09 allowlist audit — these are all live config knobs read in
    // the source tree that were never allowlisted, so envScrub silently
    // stripped them at boot (the knob would appear to do nothing). Added so
    // the documented env overrides actually take effect.
    'LORE_LANCE_BATCH_ROWS',                    // LanceDB bulk-loader batch size
    'LORE_BACKUP_KEEP',                         // backup retention count (cli backup)
    'LORE_ACCESS_FLUSH_MS',                     // accessTracker flush interval
    'LORE_FRESHNESS_TTL_HOURS',                 // freshnessEngine staleness TTL
    'LORE_WATCH_PATHS',                         // localSourceWatcher: paths to watch
    'LORE_WATCH_EXTENSIONS',                    // localSourceWatcher: file extensions
    'LORE_WATCH_RECURSIVE',                     // localSourceWatcher: recurse subdirs
    'LORE_MAINTAIN_CLEANUP_VERSIONS_OLDER_THAN', // maintain: version-prune age
    'LORE_MAINTAIN_EPHEMERAL_PATTERNS',         // maintain: ephemeral-node id patterns
    'LORE_MAINTAIN_PROTECT_TAGS',               // maintain: tags exempt from cleanup
    'LORE_MAINTAIN_NODE_ACTION',                // maintain: cold-node action
    'LORE_MAINTAIN_COLD_SIGNAL',                // maintain: cold-detection signal
    'LORE_LOAD_MAX_BYTES',                      // bulk-load: max upload bytes
    'LORE_STREAM_MAX_BYTES',                    // stream: max body bytes
    'LORE_STREAM_MAX_LINE_BYTES',               // stream: max per-line bytes (SP-12)
    'LORE_LANCE_ADD_COLUMN_SUPPORTED',          // capability flag: LanceDB add column
    'LORE_OUTBOX_LAG_THRESHOLD_SECONDS',        // outbox backpressure: lag threshold
    'LORE_OUTBOX_DEPTH_THRESHOLD',              // outbox backpressure: depth threshold
    'LORE_OUTBOX_SELFHEAL_INTERVAL_MS',         // outbox self-heal sweep interval
    'LORE_OUTBOX_SELFHEAL_GRACE_MS',            // outbox self-heal grace window
    'LORE_OUTBOX_SELFHEAL_BATCH',               // outbox self-heal batch size
    'LORE_OUTBOX_PRUNE_REPLICATED_MS',          // outbox: prune replicated entries older than N ms
    'LORE_OUTBOX_BACKEND',                      // outbox storage backend selector
    'LORE_RECALL_RANKING',                      // recall ranking strategy
    'LORE_RECALL_STAGE_TIMING',                 // WP5 — debug JSON stage timings on retrieve (default off)
    'LORE_RECALL_RECENCY_HALF_LIFE_DAYS',       // recall recency decay half-life
    'LORE_LOAD_MAX_CONCURRENT_PER_WORKSPACE',   // bulk-load concurrency cap
    'LORE_LOAD_TEMP_RETENTION_HOURS_COMPLETE',  // bulk-load temp retention (success)
    'LORE_LOAD_TEMP_RETENTION_HOURS_FAILED',    // bulk-load temp retention (failure)
    'LORE_STREAM_MAX_CONCURRENT_PER_WORKSPACE', // stream concurrency cap

    // SW-13 — configurable tuning knobs (previously hardcoded).
    // Each knob has the current value as default; operator sets to override.
    'LORE_EMBEDDED_MODEL',                       // embedded LLM model id (default: onnx-community/gemma-3-1b-it-ONNX)
    'LORE_MODEL_IDLE_UNLOAD_MS',                 // embedded model idle-unload timeout in ms (default: 180000)
    'LORE_LLM_NUM_CTX',                          // Ollama num_ctx context window (default: 32768)
    'LORE_LLM_MAX_TOKENS',                       // Anthropic max_tokens per request (default: 1024)
    'LORE_EMBED_BATCH_MAX',                      // per-provider embed batch size cap (overrides the RAM-adaptive local default; openai_compat 1000)
    'LORE_EMBED_MEM_PCT',                        // embed back-pressure: pause embedding while RSS exceeds this % of total RAM (default 70)
    'LORE_EMBED_MEM_WAIT_MS',                    // embed back-pressure: max wait before proceeding throttled (default 15000ms)
    'LORE_EMBED_TICK_MS',                        // embed-batch flush ceiling in ms (default: 5000)
    'LORE_REEMBED_CHUNK',                        // re-embed job outbox chunk size (default: 256)

    // NW-2a — envScrub allowlist completeness audit (5-high cluster).
    // These vars are all documented in CONFIGURATION.md AND read in
    // production code via indirect access (env-parameter helpers like
    // `envNum()`, `loadOtelConfig(env)`, `createCloudSyncClient({env})`),
    // which the env-scrub-allowlist-unit.ts scanner does NOT catch
    // because it only matches literal `process.env.<NAME>` reads.
    // Without these entries, operators following the documentation to
    // configure retention, Prometheus metrics, OpenTelemetry, the SIEM
    // audit exporter, HTTP rate limits, or cloud sync are SILENTLY
    // ignored — the daemon falls back to defaults with no warning.
    //
    // Maintenance policy knobs — read by engines/maintain/policy.ts
    // (process.env reads at lines 145, 151, 154, 178-181).
    'LORE_MAINTAIN_RETENTION_DAYS',              // maintain: retention window in days
    'LORE_MAINTAIN_COMPACT_FRAGMENT_THRESHOLD',  // maintain: fragment threshold for compaction
    'LORE_MAINTAIN_EPHEMERAL_TTL_DAYS',          // maintain: ephemeral-node TTL in days
    'LORE_MAINTAIN_COMPACTION',                  // maintain: enable/disable compaction phase
    'LORE_MAINTAIN_VERSION_CLEANUP',             // maintain: enable/disable version-cleanup phase
    'LORE_MAINTAIN_NODE_RETENTION',              // maintain: enable/disable node-retention phase
    'LORE_MAINTAIN_EPHEMERAL_EXPIRY',            // maintain: enable/disable ephemeral-expiry phase

    // SurrealDB engine (docs/SURREALDB_BUILD_PLAN.md Phase 1). Additive,
    // opt-in backend — nothing in the default runtime path reads these unless
    // a caller constructs a SurrealGraph.
    'LORE_SURREAL_BACKEND',                      // surreal: storage backend, 'surrealkv' (default) or 'rocksdb'
    'LORE_SURREAL_DEFINE_INDEXES',               // surreal: '1' opts into secondary indexes (leaks a handle upstream — see surrealConnection.ts)
    'LORE_SURREAL_COUNT_VIEW',                   // surreal: '0' rolls back the pre-computed getStats view (default on)
    'LORE_SURREAL_FTS',                          // surreal: '1' opts into full-text search — changes matching to whole-word
    'LORE_SURREAL_OPEN_TIMEOUT_MS',              // surreal: per-attempt connect timeout, guards the never-settling open (default 2000)
    'LORE_SURREAL_OPEN_BUDGET_MS',               // surreal: total open-retry budget before failing loudly (default 15000)
    'LORE_SURREAL_SETTLE_BUDGET_MS',             // surreal: ceiling on settleSurrealStore's post-close wait before giving up (default 2000, '0' disables)
    'LORE_SURREAL_SETTLE_POLL_MS',               // surreal: gap between directory snapshots while settleSurrealStore polls a closing store (default 25)
    'LORE_SURREAL_SETTLE_MIN_QUIET_MS',          // surreal: min wait before a store with a non-empty wal/ counts as settled (default 150)

    // TW-4c — search scan-cap + ranking weights (engines/searchRanking.ts intEnv reads).
    'LORE_SEARCH_SCAN_CAP',                      // search: candidate scan cap before ranking (default 2000)
    'LORE_ANALYTICAL_SCAN_CAP',                  // analytical timeSeries: row scan cap before JS bucketing, fail-loud over it (default 200000)
    'LORE_SEARCH_WEIGHT_LABEL',                  // search: ranking weight for label match (default 4)
    'LORE_SEARCH_WEIGHT_CONTENT',                // search: ranking weight for content match (default 2)
    'LORE_SEARCH_CONCURRENCY',                   // search admission: max concurrent native searches (default: scales to CPU cores, 2-8)
    'LORE_SEARCH_QUEUE_MAX',                     // search admission: max queued reads before shedding load with a busy error (default: concurrency*8)
    'LORE_SEARCH_WORKER',                        // opt-in: run the native LanceDB store in a crash-isolated child process (default off)
    'LORE_SEARCH_WORKER_READY_MS',               // search-worker: max wait for a (re)spawned worker to become ready (default 60000)
    'LORE_SEARCH_WORKER_CALL_MS',                // search-worker: per-call IPC timeout, covers big storeBatch/index builds (default 120000)
    'LORE_SEARCH_WORKER_MAX_RESTARTS',           // search-worker: consecutive-crash restart cap before failing fast (default 5)
    'LORE_WORKER_BASE_PATH',                     // search-worker internal: workspace base path passed to the child (set by the parent on fork)
    'LORE_WORKER_EMBED_OVERRIDES',               // search-worker internal: JSON embedding overrides passed to the child (set by the parent on fork)
    'LORE_WORKER_PARENT_EMBEDS',                 // search-worker internal: parent owns embedding, so child must not load a second model
    'LORE_WORKER_EMBED_DIM',                     // search-worker internal: parent provider vector dimension for the child's stub
    'LORE_WORKER_EMBED_MODEL',                   // search-worker internal: parent provider model identity for the child's stub
    'LORE_IS_SEARCH_WORKER',                     // search-worker internal: marks a process as a Lore search worker (prevents recursive forking)
    'LORE_SEARCH_WEIGHT_TAGS',                   // search: ranking weight for tags match (default 1)
    // Observability — Prometheus + OpenTelemetry. Read via
    // metrics.ts:72 (`env.LORE_METRICS`) and otelHooks.ts:52-54
    // (`loadOtelConfig(env)` defaults env to process.env).
    'LORE_METRICS',                              // /metrics endpoint gate: 'on' to expose Prometheus scrape surface
    'LORE_OTEL_EXPORTER_OTLP_ENDPOINT',          // OTLP collector endpoint for OpenTelemetry export
    'LORE_OTEL_SERVICE_NAME',                    // OpenTelemetry service.name attribute (default: 'lore')
    'LORE_OTEL_SAMPLING',                        // OpenTelemetry trace sampling ratio (default: 1.0)
    // Audit exporter selector — read by audit/exporter.ts via
    // AUDIT_EXPORTER_ENV_KEY = 'LORE_AUDIT_EXPORTER'.
    'LORE_AUDIT_EXPORTER',                       // SIEM audit exporter selector: file|splunk|datadog|none
    // HTTP rate-limit overrides — read by security/rateLimit.ts:86
    // via `readEnvNumber(process.env[name])`.
    'LORE_RATE_LIMIT_CAP',                       // rate-limit token bucket capacity
    'LORE_RATE_LIMIT_REFILL',                    // rate-limit token refill rate per second
    // Cloud sync — read by sync/createCloudSyncClient.ts via
    // `env['LORE_CLOUD_URL']` and `env['LORE_CLOUD_AUTH_TOKEN']` (env
    // parameter defaults to process.env). LORE_CLOUD_AUTH_TOKEN is
    // covered by the TOKEN/SECRET/KEY/AUTH regex in droppedSamples so
    // it is automatically redacted from dropped-vars debug logs.
    'LORE_CLOUD_URL',                            // cloud Lore base URL; unset → NoCloudSyncClient (local-only)
    'LORE_CLOUD_AUTH_TOKEN',                     // cloud Lore bearer token for HttpSyncClient

    // Dataplane — legacy env-sourced; keychain is the preferred path
    'DATAPLANE_URL', 'DATAPLANE_API_KEY',
    'DATAPLANE_TENANT_ID', 'DATAPLANE_ORG_ID',

    // NW-7c — hc-* audit findings: previously hardcoded knobs now env-overridable.
    // Without these entries scrubEnv() silently deletes the operator's override
    // before the consumer reads it, making the documented knob a no-op.
    'LORE_OUTBOX_POLL_MS',                   // outbox replicator idle-poll interval (default 250 ms)
    'LORE_OUTBOX_BUSY_MS',                   // outbox replicator busy-tick sleep (default 10 ms)
    'LORE_OUTBOX_CONSOLIDATION_CAP',         // embed.batch consolidation cap (default 1024 texts)
    'LORE_REPLICATOR_CONSOLIDATION_MAX',     // verbatim.upsert consolidation cap (default 256 rows)
    'LORE_SEARCH_CACHE_TTL_MS',              // verbatim search-cache entry TTL (default 1500 ms)
    'LORE_DEFERRED_SCAN_CACHE_TTL_MS',       // deferred-node scan cache TTL (default 60000 ms, 60s)
    'LORE_SEARCH_CACHE_MAX_ENTRIES',         // verbatim search-cache max entries (default 500)
    'LORE_COMPACT_GRACE_MS',                 // LanceDB compact grace window ms (default 600000, 10 min)
    'LORE_REGISTRY_IDLE_TTL_MS',             // LocalGraphRegistry idle-workspace eviction TTL (default 1800000, 30 min)
    'LORE_REGISTRY_SWEEP_MS',               // LocalGraphRegistry background sweep interval (default 600000, 10 min)
    // TW-7e — concurrency/lifecycle knobs (defaults unchanged).
    'LORE_MAX_OPEN_WORKSPACES',              // LocalGraphRegistry max open workspaces before LRU eviction (default 8)
    'LORE_DATAPLANE_HEALTH_TIMEOUT_MS',      // boot Dataplane /health ping timeout ms (default 2000)
    'LORE_CONSISTENCY_SWEEP_MS',             // consistency-sweep interval ms (default 1800000, 30 min)
    'LORE_RETENTION_FIRST_FIRE_MS',          // retention sweep: first-fire delay after boot ms (default 60000, 1 min)
    'LORE_RETENTION_INTERVAL_MS',            // retention sweep: repeat interval ms (default 86400000, 24 h)
    'LORE_COMPACT_INTERVAL_MS',              // scheduled storage-compaction sweep interval ms (default 86400000, 24 h; local/daemon mode only)
    'LORE_COMPACT_SCHEDULE_DISABLED',        // opt-out: '1' disables the scheduled compaction timer (operator compacts externally)
    'LORE_VERSION_RETENTION_DAYS',           // versions.sqlite prune: rows older than this are soft- then hard-deleted (default 90)
    'LORE_VERSION_PRUNE_INTERVAL_MS',        // versions.sqlite prune sweep interval ms (default 86400000, 24 h; local/daemon mode only)
    'LORE_VERSION_PRUNE_SCHEDULE_DISABLED',  // opt-out: '1' disables the scheduled version-prune timer

    // TW-7f — scalability caps (previously hardcoded). Without these entries
    // scrubEnv() silently deletes the operator's override before the consumer
    // reads it, making the documented knob a no-op.
    'LORE_TOPOLOGY_SCAN_CAP',                // topology overview group-by row scan cap (default 50000; local + cloud parity)
    'LORE_RECALL_FANOUT_WS_CAP',             // cross-workspace recall: max workspaces scanned (default 50)
    'LORE_RECALL_FANOUT_CONCURRENCY',        // cross-workspace recall: max workspace scans in flight (default 8)

    // TW-7d — server.ts remaining hardcoded knobs (defaults unchanged).
    'LORE_LOG_ROTATION_MS',                  // daemon in-uptime log-rotation interval ms (default 1800000, 30 min)
    'LORE_BULK_LOADER_DIM',                  // bulk-loader vector dim override; default derives from the active embedding provider

    // ARCADE-MODE (spike/arcadedb-multitenant, slice 2) — the db-per-app
    // ArcadeDB cloud backend. These are READ at boot (arcadeBoot preflight +
    // arcadeProvisioner + arcadeSecretStore + arcadeHttp), all POST-scrub, so
    // without an allowlist entry runEnvScrub() would delete them before the
    // consumer sees them and arcade boot would fail (or fall back). The
    // root/service passwords are covered by the TOKEN/SECRET/KEY/AUTH redaction
    // regex in droppedSamples, so they never appear in dropped-vars debug logs.
    'ARCADE_BASE_URL',                       // ArcadeDB HTTP endpoint (e.g. http://localhost:2480); REQUIRED in arcade mode
    'ARCADE_ROOT_PASSWORD',                  // ArcadeDB root/service-account password (operator/CI override; else secret store)
    // Per-cell service secrets for the env backend are named
    // ARCADE_SECRET_<SANITIZED_REF> by arcadeSecretStore.envVarNameFor() — a
    // dynamic set, one per provisioned cell, so they can't be enumerated as
    // static entries. Kept by a CONDITIONAL prefix (see ARCADE_SECRET_PREFIXES)
    // ONLY when the env secret backend is actually selected
    // (LORE_ARCADE_SECRET_BACKEND=env), so it can resolve them post-scrub. In
    // every other mode/backend (embedded, local, arcade with sqlite/keychain)
    // nothing reads them, so they are scrubbed like any other secret. They match
    // the SECRET redaction regex, so they never appear in dropped-vars debug logs.
    'LORE_ARCADE_SECRET_BACKEND',            // arcade secret store backend: sqlite (default) | keychain | env
    'LORE_ARCADE_CA_FILE',                   // arcade transport: private-CA file for TLS to a non-localhost ArcadeDB
    'LORE_ARCADE_MAX_CONNECTIONS',           // arcade transport: keep-alive connection cap per baseUrl (default 16)

    // ARCADE-MODE slice 5 (GA hardening) — cross-daemon lease backend + KMS
    // envelope-encryption secret store. All READ at boot POST-scrub
    // (arcadeCellLease.resolveLeaseBackend + arcadeKmsSecretStore.resolveLocalKek/
    // loadKmsKeyProvider), so without an allowlist entry runEnvScrub() deletes
    // them before the consumer sees them and arcade would fall back to its
    // default (sqlite lease / no KEK → fail-closed).
    'LORE_ARCADE_LEASE_BACKEND',             // cross-daemon lease store: sqlite (default, one-host) | arcadedb (cloud shape) — mode selector, not a secret
    'LORE_ARCADE_KMS_PROVIDER',              // KMS provider selector: local-kek (default) | aws-kms | gcp-kms — impl selector, not a secret
    'LORE_ARCADE_KMS_KEK_FILE',              // path to a 0600 file holding the base64 KEK — the secret lives IN the file, so allowlisting the PATH leaks nothing (preferred for production)
    // LORE_ARCADE_KMS_KEK is the raw base64 KEK (a SECRET). Handled like
    // ARCADE_ROOT_PASSWORD (the sibling operator-set secret above): allowlisted
    // so it survives the scrub and resolveLocalKek() can read it at consumption
    // time — the codebase does NOT read-early-and-cache the root password, so we
    // don't for the KEK either. It matches the KEY/SECRET redaction regex in
    // droppedSamples, so it never appears in dropped-vars debug logs. Tradeoff:
    // the raw KEK lingers in process.env after the scrub; prefer
    // LORE_ARCADE_KMS_KEK_FILE (above) in production so only a 0600 file path,
    // not the key material, sits in the environment.
    'LORE_ARCADE_KMS_KEK',                   // base64-encoded 32-byte KEK (SECRET; prefer LORE_ARCADE_KMS_KEK_FILE in prod)

];

/**
 * CONDITIONAL prefix allowlist — a variable is KEPT if its name starts with any
 * prefix here, in addition to the exact-match ALLOWED_VARS set. Unlike
 * ALLOWED_VARS, these apply ONLY when the owning backend is actually selected
 * (see activePrefixes() in scrubEnv). Used for dynamic var families whose full
 * names can't be enumerated statically.
 *
 * ARCADE_SECRET_ — per-cell service passwords for the env secret backend,
 * named ARCADE_SECRET_<SANITIZED_REF> by arcadeSecretStore.envVarNameFor(). One
 * per provisioned cell; the env backend needs them post-scrub so scrubEnv()
 * keeps them — but ONLY when LORE_ARCADE_SECRET_BACKEND=env, the one backend
 * that reads env. The sqlite (default) and keychain backends read elsewhere, so
 * outside the env backend these vars are scrubbed like any other secret. Gating
 * on the selected backend (not just arcade mode) keeps embedded/local scrubs —
 * and arcade with a non-env backend — strict allowlist-only, preserving the
 * S9/SP-17 invariant: after scrub, process.env holds only what a consumer reads.
 */
const ARCADE_SECRET_PREFIXES: readonly string[] = [
    'ARCADE_SECRET_',
];

export interface ScrubResult {
    kept: string[];
    droppedCount: number;
    droppedSamples: string[];  // first few dropped names, for debugging
}

/**
 * scrubEnv — delete every env var not in the allowlist.
 *
 * Safe to call exactly once at process startup. Idempotent — a second
 * call is a no-op since everything outside the allowlist is already gone.
 */
export function scrubEnv(extraAllow: readonly string[] = []): ScrubResult {
    const allow = new Set([...ALLOWED_VARS, ...extraAllow]);
    // Conditional prefixes apply only when the owning backend is selected.
    // Determinable from env alone (LORE_ARCADE_SECRET_BACKEND is itself in the
    // allowlist, so it survives the scrub): the ARCADE_SECRET_ prefix is kept
    // ONLY for the env secret backend — the only backend that reads these vars.
    // Otherwise (embedded/local, or arcade with sqlite/keychain) they are
    // scrubbed like any other secret, keeping the post-scrub surface minimal.
    const activePrefixes =
        process.env['LORE_ARCADE_SECRET_BACKEND'] === 'env' ? ARCADE_SECRET_PREFIXES : [];
    const kept: string[] = [];
    const dropped: string[] = [];

    for (const k of Object.keys(process.env)) {
        if (allow.has(k) || activePrefixes.some((p) => k.startsWith(p))) {
            kept.push(k);
        } else {
            dropped.push(k);
            delete process.env[k];
        }
    }

    return {
        kept,
        droppedCount: dropped.length,
        // Show a few dropped names for visibility, but don't log secrets.
        // Names like AWS_SECRET_ACCESS_KEY are sensitive themselves.
        // Log only the first 6 that look innocuous (no KEY/TOKEN/SECRET/PASSWORD).
        droppedSamples: dropped
            .filter((n) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(n))
            .slice(0, 6),
    };
}
