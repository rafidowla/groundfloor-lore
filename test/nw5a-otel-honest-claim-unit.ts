#!/usr/bin/env tsx
/**
 * nw5a-otel-honest-claim-unit.ts — NW-5a outcome pin.
 *
 * Audit finding: ent-otel-overclaim
 * Prior to this fix, `/metrics` reported `lore_otel_enabled=1` whenever
 * LORE_OTEL_EXPORTER_OTLP_ENDPOINT was set in the environment, even though
 * observability/otelHooks.ts is a stub with no real exporter — zero spans
 * are ever emitted. This is a false claim to operators.
 *
 * Fix: lore_otel_enabled is now 0 unless registerSpanProcessor() has been
 * called (meaning a real SDK span processor was actually attached). Setting
 * the env var is insufficient; the exporter must be wired.
 *
 * Tests:
 *   (a) No OTel env → lore_otel_enabled=0
 *   (b) Env set but no registerSpanProcessor() call → still 0
 *   (c) registerSpanProcessor() called → lore_otel_enabled=1
 *
 * Run: npx tsx test/nw5a-otel-honest-claim-unit.ts
 */

import assert from 'node:assert/strict';

import {
    _resetOtelConfigCache,
    getOtelReadiness,
    loadOtelConfig,
    registerSpanProcessor,
} from '../packages/lore/src/observability/otelHooks.js';
import { renderMetrics } from '../packages/lore/src/mcp/http/routes/metrics.js';
import { _resetMetricsCache } from '../packages/lore/src/mcp/http/routes/metrics.js';

let failures = 0;

function pass(label: string): void {
    console.log(`  ✓ ${label}`);
}

function fail(label: string, detail?: string): void {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
    failures++;
}

function extractOtelEnabled(metricsBody: string): number {
    // Match "lore_otel_enabled <value>" (no labels, at line start)
    const m = metricsBody.match(/^lore_otel_enabled\s+(\d+)/m);
    if (!m) throw new Error('lore_otel_enabled metric not found in /metrics output');
    return Number(m[1]);
}

async function main(): Promise<void> {
    console.log('NW-5a: OTel honest claim tests');

    // ─── (a) No OTel env → lore_otel_enabled=0 ──────────────────────────────
    {
        console.log('\n(a) No OTel env var — must report lore_otel_enabled=0');
        _resetOtelConfigCache();
        _resetMetricsCache();

        // Ensure env var is not set
        const savedEndpoint = process.env.LORE_OTEL_EXPORTER_OTLP_ENDPOINT;
        delete process.env.LORE_OTEL_EXPORTER_OTLP_ENDPOINT;

        try {
            const cfg = loadOtelConfig(process.env);
            if (cfg.enabled !== false) {
                fail('loadOtelConfig.enabled should be false when no endpoint configured');
            } else {
                pass('loadOtelConfig.enabled=false with no env');
            }

            const readiness = getOtelReadiness();
            if (readiness.enabled !== false) {
                fail('getOtelReadiness().enabled must be false (no registerSpanProcessor call)', `got ${readiness.enabled}`);
            } else {
                pass('getOtelReadiness().enabled=false without registerSpanProcessor');
            }

            if (readiness.endpointConfigured !== false) {
                fail('getOtelReadiness().endpointConfigured must be false with no env', `got ${readiness.endpointConfigured}`);
            } else {
                pass('getOtelReadiness().endpointConfigured=false with no env');
            }

            const body = await renderMetrics({});
            const val = extractOtelEnabled(body);
            if (val !== 0) {
                fail('renderMetrics: lore_otel_enabled must be 0 with no env', `got ${val}`);
            } else {
                pass('renderMetrics: lore_otel_enabled=0 with no env');
            }
        } finally {
            if (savedEndpoint !== undefined) {
                process.env.LORE_OTEL_EXPORTER_OTLP_ENDPOINT = savedEndpoint;
            }
        }
    }

    // ─── (b) Env set but no registerSpanProcessor → still 0 ─────────────────
    {
        console.log('\n(b) Env var set, no registerSpanProcessor — must still report lore_otel_enabled=0');
        _resetOtelConfigCache();
        _resetMetricsCache();

        const savedEndpoint = process.env.LORE_OTEL_EXPORTER_OTLP_ENDPOINT;
        process.env.LORE_OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel-collector:4318';

        try {
            const cfg = loadOtelConfig(process.env);
            if (cfg.enabled !== true) {
                fail('loadOtelConfig.enabled should be true (env var intent)', `got ${cfg.enabled}`);
            } else {
                pass('loadOtelConfig.enabled=true (env var sets intent)');
            }

            const readiness = getOtelReadiness();
            if (readiness.enabled !== false) {
                fail(
                    'getOtelReadiness().enabled must be false without registerSpanProcessor — env alone is insufficient',
                    `got ${readiness.enabled}`,
                );
            } else {
                pass('getOtelReadiness().enabled=false despite env var (no exporter wired)');
            }

            if (readiness.endpointConfigured !== true) {
                fail('getOtelReadiness().endpointConfigured should be true (intent flag)', `got ${readiness.endpointConfigured}`);
            } else {
                pass('getOtelReadiness().endpointConfigured=true (env intent preserved)');
            }

            const body = await renderMetrics({});
            const val = extractOtelEnabled(body);
            if (val !== 0) {
                fail(
                    'renderMetrics: lore_otel_enabled must be 0 even with endpoint env (no exporter wired)',
                    `got ${val}`,
                );
            } else {
                pass('renderMetrics: lore_otel_enabled=0 with env set but no exporter wired');
            }
        } finally {
            if (savedEndpoint !== undefined) {
                process.env.LORE_OTEL_EXPORTER_OTLP_ENDPOINT = savedEndpoint;
            } else {
                delete process.env.LORE_OTEL_EXPORTER_OTLP_ENDPOINT;
            }
        }
    }

    // ─── (c) registerSpanProcessor called → lore_otel_enabled=1 ─────────────
    {
        console.log('\n(c) registerSpanProcessor() called — must report lore_otel_enabled=1');
        _resetOtelConfigCache();
        _resetMetricsCache();

        const savedEndpoint = process.env.LORE_OTEL_EXPORTER_OTLP_ENDPOINT;
        process.env.LORE_OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel-collector:4318';

        try {
            // Simulate SDK wiring: register a real (or stub) span processor
            registerSpanProcessor();

            const readiness = getOtelReadiness();
            if (readiness.enabled !== true) {
                fail('getOtelReadiness().enabled must be true after registerSpanProcessor()', `got ${readiness.enabled}`);
            } else {
                pass('getOtelReadiness().enabled=true after registerSpanProcessor()');
            }

            const body = await renderMetrics({});
            const val = extractOtelEnabled(body);
            if (val !== 1) {
                fail('renderMetrics: lore_otel_enabled must be 1 after registerSpanProcessor()', `got ${val}`);
            } else {
                pass('renderMetrics: lore_otel_enabled=1 after registerSpanProcessor()');
            }
        } finally {
            if (savedEndpoint !== undefined) {
                process.env.LORE_OTEL_EXPORTER_OTLP_ENDPOINT = savedEndpoint;
            } else {
                delete process.env.LORE_OTEL_EXPORTER_OTLP_ENDPOINT;
            }
        }
    }

    // ─── cleanup ──────────────────────────────────────────────────────────────
    _resetOtelConfigCache();
    _resetMetricsCache();

    console.log();
    if (failures > 0) {
        console.error(`FAIL — ${failures} assertion(s) failed`);
        process.exit(1);
    }
    console.log('PASS — all NW-5a assertions green');
}

main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
