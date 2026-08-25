#!/usr/bin/env node
/**
 * scripts/sprint-R-live-smoke.mjs — Sprint R Day-1 dogfood reproduction.
 *
 * Fetches a real recall payload from the v3.7.0 daemon (legacy
 * ranking), then re-ranks the same payload IN PROCESS through the
 * v3.8.0 ranking helper. Prints the top-5 type breakdown for both so
 * the operator can see ranking shifting decisions / curated content
 * above auto-extracted noise.
 *
 * Not a unit test — a one-shot live verification artifact.
 */
import { rankScore } from '../dist/lore/src/recall/ranking.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let token = '';
try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
    token = cfg.loreBearerToken ?? '';
} catch {}

const url = 'http://localhost:3847/api/recall?topic=What+did+we+ship+in+Sprint+S&workspace=*&max=20';
const r = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const json = await r.json();
if (!json.results) { console.error('no results from daemon:', json); process.exit(1); }

const legacyTop5 = json.results.slice(0, 5).map((x) => x.type);
const now = Date.now();
const reranked = [...json.results]
    .map((n, idx) => ({ n, fs: rankScore({ node: { type: n.type, updatedAt: n.updatedAt, metadata: n.metadata, label: n.label }, baseScore: 1 / (1 + idx), nowMs: now }) }))
    .sort((a, b) => b.fs - a.fs)
    .slice(0, 5)
    .map((x) => x.n.type);

console.log(JSON.stringify({
    topic: json.topic,
    workspaces: json.projectsSeen,
    legacyTop5Types: legacyTop5,
    rerankedTop5Types: reranked,
    rerankPromotedDecisions: reranked.filter((t) => ['decision', 'convention', 'bug_pattern', 'architecture', 'note', 'troubleshooting'].includes(t)).length,
    legacyDecisions: legacyTop5.filter((t) => ['decision', 'convention', 'bug_pattern', 'architecture', 'note', 'troubleshooting'].includes(t)).length,
}, null, 2));
