#!/usr/bin/env node
/**
 * 02-llm-eval.mjs
 *
 * Phase 2 of the eval: LLM compression via LFM2.5-1.2B-Thinking.
 * Reads each corpus file, sends to Ollama with a "compress" prompt,
 * measures: compression ratio, latency p50/p95, faithfulness
 * (literal substring match for cited identifiers), failure rate.
 *
 * Outputs:
 *   results/02-llm.csv
 *   results/02-llm-outputs/<file>.txt   (final answer only, post </think>)
 *   results/02-llm-fulltrace/<file>.txt (the whole streamed response)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(__dirname, '../corpus');
const RESULTS = path.resolve(__dirname, '../results');
const SUFFIX = process.env.SUFFIX ?? 'thinking';
const OUT = path.join(RESULTS, `02-llm-${SUFFIX}-outputs`);
const TRACE = path.join(RESULTS, `02-llm-${SUFFIX}-fulltrace`);
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TRACE, { recursive: true });

const MODEL = process.env.MODEL ?? 'lfm2.5-thinking:1.2b';
const OLLAMA = 'http://localhost:11434/api/generate';
const tokens = (b) => Math.round(b / 4);

const PROMPT_TEMPLATE = (label, raw) => `You are a code-tool response compressor.

Goal: produce a 100-200 token summary that preserves every named identifier, file path, line number, and the answer the agent would care about. Drop noise: scores, internal IDs, redundant fields.

Rules:
- Preserve literal identifiers (function names, class names, file paths) — do not rephrase them.
- If the response says no results, say "no results" and stop.
- Output plain text. No markdown headings. No commentary.

Tool response (${label}):
\`\`\`
${raw.slice(0, 12000)}
\`\`\`

Compressed summary:`;

async function callOllama(prompt) {
    const t0 = performance.now();
    const r = await fetch(OLLAMA, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            model: MODEL,
            prompt,
            stream: false,
            options: { num_predict: 1500, temperature: 0.05, top_k: 50 },
        }),
    });
    const j = await r.json();
    const t1 = performance.now();
    return { text: j.response ?? '', ms: t1 - t0, doneReason: j.done_reason };
}

function splitThinking(text) {
    const close = text.lastIndexOf('</think>');
    if (close >= 0) {
        return {
            thinking: text.slice(0, close + 8),
            answer: text.slice(close + 8).trim(),
        };
    }
    return { thinking: '', answer: text.trim() };
}

/** Faithfulness: every quoted identifier must appear in the source verbatim. */
function checkFaithfulness(answer, source) {
    const idRe = /[A-Za-z_][\w]+(?:\.[A-Za-z_][\w]+)*/g;
    const ids = answer.match(idRe) ?? [];
    const fakes = [];
    for (const id of ids) {
        // Skip very short / trivial / common-word strings
        if (id.length < 6) continue;
        if (/^(the|that|this|with|from|when|then|while|where|what|which|null|true|false|undefined)$/i.test(id)) continue;
        if (!source.includes(id)) fakes.push(id);
    }
    // De-dupe
    return [...new Set(fakes)];
}

/* ─── Run ───────────────────────────────────────────────────── */

const files = fs.readdirSync(CORPUS).sort();
const rows = [];
const latencies = [];

for (const name of files) {
    const raw = fs.readFileSync(path.join(CORPUS, name), 'utf8');
    const prompt = PROMPT_TEMPLATE(name, raw);
    process.stderr.write(`[${name}] calling ${MODEL}…\n`);
    let out;
    try {
        out = await callOllama(prompt);
    } catch (e) {
        rows.push({ file: name, failed: 1, reason: e.message });
        continue;
    }
    const split = splitThinking(out.text);
    const fakes = checkFaithfulness(split.answer, raw);
    const ratio = raw.length === 0 ? 0 : split.answer.length / raw.length;
    rows.push({
        file: name,
        rawBytes: raw.length,
        answerBytes: split.answer.length,
        thinkingBytes: split.thinking.length,
        rawTokens: tokens(raw.length),
        answerTokens: tokens(split.answer.length),
        reductionPct: (1 - ratio) * 100,
        latencyMs: Math.round(out.ms),
        doneReason: out.doneReason,
        fakeIds: fakes.length,
        failed: out.doneReason === 'length' ? 1 : 0,
    });
    latencies.push(out.ms);
    fs.writeFileSync(path.join(OUT, name + '.answer.txt'), split.answer);
    fs.writeFileSync(path.join(TRACE, name + '.full.txt'), out.text);
    process.stderr.write(
        `  → ${Math.round(out.ms)} ms, answer ${split.answer.length} bytes, ${fakes.length} fake ids, done=${out.doneReason}\n`,
    );
}

latencies.sort((a, b) => a - b);
const p50 = Math.round(latencies[Math.floor(latencies.length * 0.5)] ?? 0);
const p95 = Math.round(latencies[Math.floor(latencies.length * 0.95)] ?? 0);

const totals = rows.reduce(
    (a, r) => ({
        rawBytes: a.rawBytes + (r.rawBytes ?? 0),
        answerBytes: a.answerBytes + (r.answerBytes ?? 0),
        thinkingBytes: a.thinkingBytes + (r.thinkingBytes ?? 0),
        fakes: a.fakes + (r.fakeIds ?? 0),
        failed: a.failed + (r.failed ?? 0),
    }),
    { rawBytes: 0, answerBytes: 0, thinkingBytes: 0, fakes: 0, failed: 0 },
);
const totalReduction = ((totals.rawBytes - totals.answerBytes) / totals.rawBytes) * 100;

const csv = [
    'file,rawBytes,answerBytes,thinkingBytes,rawTokens,answerTokens,reductionPct,latencyMs,doneReason,fakeIds,failed',
    ...rows.map((r) =>
        [
            r.file,
            r.rawBytes ?? '',
            r.answerBytes ?? '',
            r.thinkingBytes ?? '',
            r.rawTokens ?? '',
            r.answerTokens ?? '',
            (r.reductionPct ?? 0).toFixed(1),
            r.latencyMs ?? '',
            r.doneReason ?? '',
            r.fakeIds ?? '',
            r.failed ?? '',
        ].join(','),
    ),
    `TOTAL,${totals.rawBytes},${totals.answerBytes},${totals.thinkingBytes},${tokens(totals.rawBytes)},${tokens(totals.answerBytes)},${totalReduction.toFixed(1)},p50=${p50}|p95=${p95},,${totals.fakes},${totals.failed}`,
].join('\n');

fs.writeFileSync(path.join(RESULTS, `02-llm-${SUFFIX}.csv`), csv);
console.log(csv);
console.log(
    `\n→ wrote results/02-llm.csv | model=${MODEL} | p50=${p50} ms | p95=${p95} ms | total reduction ${totalReduction.toFixed(1)}% | ${totals.fakes} fake ids | ${totals.failed} failed`,
);
