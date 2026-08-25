/**
 * observability/otelHooks.ts — Sprint C1 OTel provisioning hooks.
 *
 * Provision-only: env-configurable knobs and an in-process span shim
 * Lore code can call without paying an OTel SDK dependency. Concrete
 * collector deployment + the @opentelemetry/sdk-node wire-up are part
 * of the cloud activation track (Task #12), not local Lore.
 *
 * Environment:
 *   LORE_OTEL_EXPORTER_OTLP_ENDPOINT — when set, hooks report ready=true
 *     so the cloud-activation bootstrap can later attach a real SDK
 *     exporter. When unset, every hook is a no-op fast path.
 *   LORE_OTEL_SERVICE_NAME — defaults to "lore" when not set.
 *   LORE_OTEL_SAMPLING — "always"|"never"|"ratio:<0..1>" (default "ratio:0.05")
 *
 * The shim is intentionally tiny: a span() function that returns a
 * handle with end() + setAttribute(). When OTel is wired, the same
 * call sites flip to real spans without touching call-site code.
 *
 * Why ship the shim now rather than wait for cloud activation:
 *   - Lets the codebase mark hot-path boundaries (replicator tick,
 *     embed enqueue, recall request) today so when the SDK lands the
 *     traces are immediately useful.
 *   - Keeps the operational metric set (which the /metrics endpoint
 *     exposes) consistent with the trace names the collector will
 *     eventually see — single source of truth for span names.
 *
 * Sprint C-local contract: provision-only; concrete cloud impl deferred.
 */

export interface OtelConfig {
    endpoint: string | null;
    serviceName: string;
    sampling: { kind: 'always' | 'never' | 'ratio'; ratio: number };
    enabled: boolean;
}

export interface SpanHandle {
    name: string;
    startedAt: number;
    setAttribute(key: string, value: string | number | boolean): void;
    end(): void;
}

let configCache: OtelConfig | null = null;
let spansStarted = 0;
let spansEnded = 0;
/**
 * True only when a real span processor has been registered via
 * registerSpanProcessor(). An env var alone is not sufficient —
 * the exporter must actually be wired before this flips.
 *
 * Why: setting LORE_OTEL_EXPORTER_OTLP_ENDPOINT without wiring the
 * SDK emits zero spans. Reporting lore_otel_enabled=1 in that state
 * is a false claim to operators. This flag tracks real SDK readiness
 * rather than intent.
 */
let exporterRegistered = false;

/** Load OTel config from env. Idempotent; result is cached. */
export function loadOtelConfig(env: NodeJS.ProcessEnv = process.env): OtelConfig {
    if (configCache) return configCache;
    const endpoint = env.LORE_OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || null;
    const serviceName = env.LORE_OTEL_SERVICE_NAME?.trim() || 'lore';
    const samplingRaw = env.LORE_OTEL_SAMPLING?.trim() || 'ratio:0.05';
    let sampling: OtelConfig['sampling'] = { kind: 'ratio', ratio: 0.05 };
    if (samplingRaw === 'always') sampling = { kind: 'always', ratio: 1 };
    else if (samplingRaw === 'never') sampling = { kind: 'never', ratio: 0 };
    else if (samplingRaw.startsWith('ratio:')) {
        const r = Number(samplingRaw.slice('ratio:'.length));
        if (Number.isFinite(r) && r >= 0 && r <= 1) sampling = { kind: 'ratio', ratio: r };
    }
    configCache = {
        endpoint,
        serviceName,
        sampling,
        enabled: Boolean(endpoint),
    };
    return configCache;
}

/** Reset cache — tests only. */
export function _resetOtelConfigCache(): void {
    configCache = null;
    spansStarted = 0;
    spansEnded = 0;
    exporterRegistered = false;
}

/**
 * registerSpanProcessor — call this once when a real OTel SDK span
 * processor is attached (e.g. an OTLP HTTP exporter). Until this is
 * called, lore_otel_enabled stays 0 regardless of env vars.
 *
 * This is the single flip point that makes /metrics honest: it can
 * only be called by code that has actually constructed an exporter,
 * not by env var detection alone.
 */
export function registerSpanProcessor(): void {
    exporterRegistered = true;
}

/**
 * span — create a span handle. When OTel is unwired, returns a no-op
 * sampled by the configured ratio so call sites can still gate
 * expensive attribute building.
 *
 * When the SDK lands, this function is the single swap point.
 */
export function span(name: string, attrs?: Record<string, string | number | boolean>): SpanHandle {
    const cfg = loadOtelConfig();
    spansStarted++;
    const startedAt = Date.now();
    const handle: SpanHandle = {
        name,
        startedAt,
        setAttribute(_key: string, _value: string | number | boolean): void {
            // No-op in provision mode. Cloud activation replaces this
            // with the real OTel span.setAttribute call.
            void _key;
            void _value;
        },
        end(): void {
            spansEnded++;
        },
    };
    if (cfg.enabled && attrs) {
        for (const [k, v] of Object.entries(attrs)) handle.setAttribute(k, v);
    }
    return handle;
}

/**
 * Diagnostic — used by /metrics to surface OTel readiness.
 *
 * `enabled` is true ONLY when a real span processor has been registered
 * via registerSpanProcessor(). An endpoint env var being set is NOT
 * sufficient — this module is a stub with no real exporter, so env-only
 * state must not be reported as "enabled" to operators.
 *
 * `endpointConfigured` reflects whether the env var is set (intent),
 * distinct from `enabled` (reality). Callers that need to know whether
 * a user attempted OTel configuration can inspect endpointConfigured.
 */
export function getOtelReadiness(): { enabled: boolean; endpointConfigured: boolean; endpoint: string | null; spansStarted: number; spansEnded: number } {
    const cfg = loadOtelConfig();
    return {
        enabled: exporterRegistered,
        endpointConfigured: cfg.enabled,
        endpoint: cfg.endpoint,
        spansStarted,
        spansEnded,
    };
}

/**
 * shouldSample — caller-side sampling gate. Returns true when the
 * caller should bother building span attributes. Uses the configured
 * ratio. Caller may also short-circuit on cfg.enabled=false.
 */
export function shouldSample(): boolean {
    const cfg = loadOtelConfig();
    if (cfg.sampling.kind === 'always') return true;
    if (cfg.sampling.kind === 'never') return false;
    return Math.random() < cfg.sampling.ratio;
}
