#!/usr/bin/env node
/**
 * 01-deterministic-eval.mjs
 *
 * Phase 1 of the eval: deterministic-only response transforms (no LLM).
 * Simulates the P0/P1/P2 deliverables from
 * docs/internal/strategy-mcp-token-efficiency.md against the captured
 * corpus. Outputs results/01-deterministic.csv.
 *
 * Transforms applied per response:
 *   T1. Mode-thin (P1) — keep id + label + 1-line snippet per result
 *       item; drop bodies, internal IDs, redundant metadata.
 *   T2. Negative-evidence stamp (P2) — when a response describes
 *       zero results (impactedCount: 0, no processes, etc.), replace
 *       it with a 4-field "not found" envelope.
 *   T3. Outline-extract (file responses) — for raw .ts/.md files,
 *       extract a signature outline rather than ship the body.
 *
 * Schema-overhead reduction (P0) is measured separately because it
 * requires a live MCP daemon. See results/00-schema-baseline.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(__dirname, '../corpus');
const RESULTS = path.resolve(__dirname, '../results');
fs.mkdirSync(RESULTS, { recursive: true });

// Rough Anthropic tokenizer: ~4 chars / token for English+JSON.
// Use this for a directional figure; precise tokenization needs
// @anthropic-ai/sdk's tokenizer or tiktoken.
const tokens = (bytes) => Math.round(bytes / 4);

/* ─── Transforms ────────────────────────────────────────────── */

function isCodeResponse(name) {
    return name.endsWith('.json');
}

/** T1 — mode-thin for gitnexus query responses. */
function thinQuery(obj) {
    if (!obj?.processes) return obj;
    return {
        processes: obj.processes.map((p) => ({
            id: p.id,
            summary: p.summary,
        })),
        _meta: {
            confidence: obj.processes.length === 0 ? 0.1 : 0.9,
            count: obj.processes.length,
        },
    };
}

/** T1 — mode-thin for gitnexus context responses. */
function thinContext(obj) {
    if (!obj?.symbol) return obj;
    const trimRefs = (arr) =>
        (arr || []).slice(0, 5).map((r) => ({ uid: r.uid, name: r.name }));
    return {
        symbol: {
            uid: obj.symbol.uid,
            name: obj.symbol.name,
            filePath: obj.symbol.filePath,
            startLine: obj.symbol.startLine,
        },
        incoming: obj.incoming
            ? {
                  calls: trimRefs(obj.incoming.calls),
                  imports: trimRefs(obj.incoming.imports),
              }
            : undefined,
        outgoing: obj.outgoing
            ? {
                  calls: trimRefs(obj.outgoing.calls),
                  imports: trimRefs(obj.outgoing.imports),
              }
            : undefined,
        _meta: {
            confidence: 0.95,
            truncated_to: 5,
        },
    };
}

/** T1 — mode-thin for gitnexus impact responses. */
function thinImpact(obj) {
    if (obj?.impactedCount === 0) {
        // T2 — negative evidence stamp
        return {
            target: obj.target,
            direction: obj.direction,
            negative_evidence: {
                searched: 'upstream + downstream',
                found: 0,
                hint: 'No callers found at any depth — symbol may be entry point or unused.',
            },
            _meta: { confidence: 0.7 },
        };
    }
    return {
        target: obj.target,
        direction: obj.direction,
        risk: obj.risk,
        summary: obj.summary,
        affected_processes: (obj.affected_processes || []).slice(0, 5).map((p) => ({
            name: p.name,
            hits: p.hits,
        })),
        _meta: {
            confidence: 0.95,
            truncated_to: 5,
        },
    };
}

/** T3 — outline-extract for .ts files. */
function outlineTs(src) {
    const lines = src.split('\n');
    const out = [];
    const sigRe =
        /^(\s*)(export\s+)?(async\s+)?(function|class|interface|type|const|enum)\s+([A-Za-z_][\w]*)/;
    const methodRe =
        /^\s+(public|private|protected|static|async)?\s*([a-zA-Z_][\w]*)\s*\(/;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(sigRe);
        if (m) {
            out.push(`L${i + 1}: ${lines[i].trim().slice(0, 120)}`);
            continue;
        }
        const mm = lines[i].match(methodRe);
        if (mm && /^\s{4,}/.test(lines[i])) {
            out.push(`L${i + 1}:   ${lines[i].trim().slice(0, 120)}`);
        }
    }
    return {
        kind: 'outline',
        path: '<<file>>',
        lines: lines.length,
        outline: out.slice(0, 80),
        _meta: { confidence: 0.95, mode: 'thin' },
    };
}

/** T3 — outline-extract for markdown. */
function outlineMd(src) {
    const lines = src.split('\n');
    const headings = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
        if (m) headings.push(`L${i + 1}: ${'  '.repeat(m[1].length - 1)}${m[2]}`);
    }
    return {
        kind: 'outline',
        path: '<<doc>>',
        lines: lines.length,
        headings,
        _meta: { confidence: 0.95, mode: 'thin' },
    };
}

/** Dispatch transform by filename pattern. */
function transform(name, raw) {
    if (name.endsWith('.ts')) return outlineTs(raw);
    if (name.endsWith('.md')) return outlineMd(raw);
    let obj;
    try {
        obj = JSON.parse(raw);
    } catch {
        return { passthrough: raw.slice(0, 400) };
    }
    if (obj.processes) return thinQuery(obj);
    if (obj.symbol) return thinContext(obj);
    if (obj.impactedCount !== undefined) return thinImpact(obj);
    if (obj.error) {
        return {
            negative_evidence: {
                error: obj.error,
                hint: 'Symbol not in index — check spelling or run code analyze.',
            },
            _meta: { confidence: 0.0 },
        };
    }
    return obj;
}

/* ─── Run ───────────────────────────────────────────────────── */

const files = fs.readdirSync(CORPUS).sort();
const rows = [];
const totals = { rawBytes: 0, thinBytes: 0 };

for (const name of files) {
    const raw = fs.readFileSync(path.join(CORPUS, name), 'utf8');
    const out = transform(name, raw);
    const thin = JSON.stringify(out, null, 2);
    const rb = raw.length;
    const tb = thin.length;
    totals.rawBytes += rb;
    totals.thinBytes += tb;
    rows.push({
        file: name,
        rawBytes: rb,
        thinBytes: tb,
        rawTokens: tokens(rb),
        thinTokens: tokens(tb),
        reductionPct: ((rb - tb) / rb) * 100,
    });
    fs.writeFileSync(
        path.join(RESULTS, `thin-${name.replace(/\.(json|ts|md)$/, '')}.json`),
        thin,
    );
}

const csv = [
    'file,rawBytes,thinBytes,rawTokens,thinTokens,reductionPct',
    ...rows.map(
        (r) =>
            `${r.file},${r.rawBytes},${r.thinBytes},${r.rawTokens},${r.thinTokens},${r.reductionPct.toFixed(1)}`,
    ),
    `TOTAL,${totals.rawBytes},${totals.thinBytes},${tokens(totals.rawBytes)},${tokens(totals.thinBytes)},${(((totals.rawBytes - totals.thinBytes) / totals.rawBytes) * 100).toFixed(1)}`,
].join('\n');

fs.writeFileSync(path.join(RESULTS, '01-deterministic.csv'), csv);
console.log(csv);
console.log(`\n→ wrote results/01-deterministic.csv + ${rows.length} thin-* artefacts.`);
