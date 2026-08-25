#!/usr/bin/env tsx
/**
 * test/sprint-B-local-property.ts — Sprint B-local gate test
 *
 * Eight cases asserting Sprint B-local contract per
 * docs/audits/sprint-B-local-parity-audit-log-2026-05-24.md:
 *
 *   B-D1   REST /api/resolve-deferred handler exists in retention.ts
 *          (parity sibling for MCP resolve_deferred — gap #9 closed).
 *   B-D2   REST /api/prune-ephemeral handler exists in retention.ts
 *          (parity sibling for MCP prune_ephemeral — gap #8 closed).
 *   B-D3   AuditLogExporter interface exists with required methods
 *          (name, configure, start, onAuditEvent, stop) and the
 *          parseExporterChoice helper recognizes the 5 documented
 *          values (file/splunk/datadog/elastic/none) — cloud-pluggable
 *          contract.
 *   B-D4   FileTailExporter reference impl ships and conforms to the
 *          AuditLogExporter contract end-to-end (configure → start →
 *          onAuditEvent × N → stop, with N records appearing in the
 *          sidecar after flush).
 *   B-D5   AuditLog.attachExporter wires correctly — entries logged
 *          via AuditLog.log() reach the attached exporter without
 *          regressing the audit.jsonl write path (additive observer).
 *   B-D6   AuditLog.log catches exporter throws so a misbehaving
 *          exporter never fails a tool call (suppression contract).
 *   B-D7   Sprint L workspace_required sentinel — governance.ts MCP
 *          tools still reject empty workspace (regression sentinel).
 *   B-D8   Sprint O outbox sentinel — bulkWrite import still present
 *          (regression sentinel).
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
    AUDIT_EXPORTER_ENV_KEY,
    NoopExporter,
    parseExporterChoice,
    type AuditLogExporter,
} from '../packages/lore/src/audit/exporter.js';
import { FileTailExporter } from '../packages/lore/src/audit/fileTailExporter.js';
import { AuditLog } from '../packages/lore/src/security/audit.js';

let xfailPassed = 0;
let unexpectedPass = 0;
let runnerErrors = 0;
let expectPassed = 0;
let expectFailed = 0;
const pending: Array<Promise<void>> = [];

function expectPass(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try {
            await fn();
            console.log(`  ✓ ${name} (pass)`);
            expectPassed++;
        } catch (err) {
            console.error(`  ✗ ${name} — REGRESSION: ${(err as Error).message.split('\n')[0]?.slice(0, 240)}`);
            expectFailed++;
        }
    })().catch((err) => {
        console.error(`  ! ${name} — harness error: ${(err as Error).message}`);
        runnerErrors++;
    }));
}

const SRC_ROOT = join(process.cwd(), 'packages/lore/src');

console.log('Sprint B-local gate test — V2b parity + audit-log exporter (8 cases)');

/* ─────────────────── B-D1 ─────────────────── */
expectPass('B-D1 REST /api/resolve-deferred handler shipped (gap #9 closed)', () => {
    const src = readFileSync(join(SRC_ROOT, 'mcp/http/routes/retention.ts'), 'utf-8');
    assert.match(src, /\/api\/resolve-deferred/, 'retention.ts must declare /api/resolve-deferred');
    assert.match(src, /stampResolved/, 'handler must forward to engines/deferred.stampResolved');
});

/* ─────────────────── B-D2 ─────────────────── */
expectPass('B-D2 REST /api/prune-ephemeral handler shipped (gap #8 closed)', () => {
    const src = readFileSync(join(SRC_ROOT, 'mcp/http/routes/retention.ts'), 'utf-8');
    assert.match(src, /\/api\/prune-ephemeral/, 'retention.ts must declare /api/prune-ephemeral');
    assert.match(src, /pruneEphemeralNodes/, 'handler must forward to loreGraph.pruneEphemeralNodes');
});

/* ─────────────────── B-D3 ─────────────────── */
expectPass('B-D3 AuditLogExporter interface + parseExporterChoice (cloud-pluggable)', () => {
    // Smoke the interface via NoopExporter — it must implement every
    // required method.
    const noop = new NoopExporter();
    assert.equal(noop.name, 'noop');
    assert.equal(typeof noop.configure, 'function');
    assert.equal(typeof noop.start, 'function');
    assert.equal(typeof noop.onAuditEvent, 'function');
    assert.equal(typeof noop.stop, 'function');
    // The 5 documented choices must all parse to themselves.
    assert.equal(parseExporterChoice('file'), 'file');
    assert.equal(parseExporterChoice('splunk'), 'splunk');
    assert.equal(parseExporterChoice('datadog'), 'datadog');
    assert.equal(parseExporterChoice('elastic'), 'elastic');
    assert.equal(parseExporterChoice('none'), 'none');
    // Unknown values fall back to file (no silent signal drop).
    assert.equal(parseExporterChoice('rumpelstiltskin'), 'file');
    assert.equal(parseExporterChoice(undefined), 'file');
    // Env key constant matches the spec.
    assert.equal(AUDIT_EXPORTER_ENV_KEY, 'LORE_AUDIT_EXPORTER');
});

/* ─────────────────── B-D4 ─────────────────── */
expectPass('B-D4 FileTailExporter ships + emits lines end-to-end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lore-sprint-b-'));
    const sidecar = join(dir, 'audit-export.jsonl');
    const exporter = new FileTailExporter({ sidecarPath: sidecar });
    try {
        exporter.configure({ env: {}, auditLogPath: join(dir, 'audit.jsonl') });
        exporter.start();
        assert.equal(exporter.getSidecarPath(), sidecar);
        const sample = {
            timestamp: new Date().toISOString(),
            actor: { id: 'tester', roles: [] },
            toolName: 'sprint_b_smoke',
            args: {},
            result: 'success' as const,
            durationMs: 1,
        };
        exporter.onAuditEvent(sample);
        exporter.onAuditEvent(sample);
        await exporter.stop(); // forces final flush
        assert.equal(existsSync(sidecar), true, 'sidecar must be created');
        const lines = readFileSync(sidecar, 'utf-8').split('\n').filter(Boolean);
        assert.equal(lines.length, 2, `expected 2 lines, got ${lines.length}`);
        const parsed = JSON.parse(lines[0]!);
        assert.equal(parsed.toolName, 'sprint_b_smoke');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/* ─────────────────── B-D5 ─────────────────── */
expectPass('B-D5 AuditLog.attachExporter wires exporter to write path (additive)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lore-sprint-b-'));
    const auditPath = join(dir, 'audit.jsonl');
    const seen: string[] = [];
    const spy: AuditLogExporter = {
        name: 'spy',
        configure() { /* no-op */ },
        start() { /* no-op */ },
        onAuditEvent(rec) { seen.push(rec.toolName); },
        stop() { /* no-op */ },
    };
    try {
        const log = new AuditLog({ path: auditPath });
        log.attachExporter(spy);
        assert.equal(log.getExporter(), spy);
        log.log({
            actor: { id: 'tester', roles: [] } as never,
            toolName: 'wired_through',
            args: {},
            result: 'success',
            durationMs: 0,
        });
        // Yield a tick for fs.promises.appendFile to flush.
        await new Promise((r) => setTimeout(r, 25));
        assert.deepEqual(seen, ['wired_through'], 'exporter must receive the event');
        // audit.jsonl must still be written (additive contract).
        const contents = readFileSync(auditPath, 'utf-8');
        assert.match(contents, /wired_through/, 'audit.jsonl must still be written');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/* ─────────────────── B-D6 ─────────────────── */
expectPass('B-D6 AuditLog.log suppresses exporter throws (never fails tool call)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lore-sprint-b-'));
    const bomb: AuditLogExporter = {
        name: 'bomb',
        configure() { /* no-op */ },
        start() { /* no-op */ },
        onAuditEvent() { throw new Error('detonation'); },
        stop() { /* no-op */ },
    };
    try {
        const log = new AuditLog({ path: join(dir, 'audit.jsonl') });
        log.attachExporter(bomb);
        // Must NOT throw. Capture stderr so the suppression line
        // doesn't pollute test output.
        const origError = console.error;
        const suppressed: string[] = [];
        console.error = (...args: unknown[]) => { suppressed.push(args.map(String).join(' ')); };
        try {
            log.log({
                actor: { id: 'tester', roles: [] } as never,
                toolName: 'bombproof',
                args: {},
                result: 'success',
                durationMs: 0,
            });
        } finally {
            console.error = origError;
        }
        assert.ok(suppressed.some((s) => s.includes('exporter.onAuditEvent threw')), 'must log suppression diagnostic');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/* ─────────────────── B-D7 — Sprint L sentinel ─────────────────── */
expectPass('B-D7 Sprint L workspace_required sentinel (governance.ts intact)', () => {
    const src = readFileSync(join(SRC_ROOT, 'mcp/tools/governance.ts'), 'utf-8');
    // Both MCP tools we added REST siblings for must STILL enforce
    // workspace_required — Sprint L1e invariant.
    assert.match(src, /workspace_required/, 'governance.ts must still enforce workspace_required (Sprint L)');
    assert.match(src, /resolve_deferred/, 'resolve_deferred tool still registered');
    assert.match(src, /prune_ephemeral/, 'prune_ephemeral tool still registered');
});

/* ─────────────────── B-D8 — Sprint O sentinel ─────────────────── */
expectPass('B-D8 Sprint O outbox sentinel (bulkWrite uses withOutbox)', () => {
    const src = readFileSync(join(SRC_ROOT, 'mcp/http/routes/bulkWrite.ts'), 'utf-8');
    assert.match(src, /withOutbox/, 'Sprint O outbox wiring must remain in bulkWrite.ts');
});

/* ───────────────────────── Drain ───────────────────────── */
(async () => {
    await Promise.all(pending);
    const total = expectPassed + expectFailed + xfailPassed + unexpectedPass;
    console.log('');
    console.log(`Sprint B-local gate: ${expectPassed + xfailPassed}/${total} pass `
        + `(expectPass=${expectPassed} xfailPass=${xfailPassed} `
        + `regress=${expectFailed} unexpectedPass=${unexpectedPass} runnerErr=${runnerErrors})`);
    if (expectFailed > 0 || unexpectedPass > 0 || runnerErrors > 0) {
        process.exit(1);
    }
    process.exit(0);
})();
