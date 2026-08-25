/**
 * examples/supersession/demo.mjs — the supersession demo.
 *
 * The one thing a rules file (CLAUDE.md, .cursorrules) cannot do: tell an
 * agent which of two conflicting decisions is the one in force TODAY.
 *
 * Sequence:
 *   1. Store a decision.                      → agent asks, gets that answer
 *   2. The decision changes.                  → store the replacement
 *   3. Declare the supersession, with reason. → agent asks again, gets ONLY
 *                                               the current answer
 *   4. Ask for the history.                   → the old decision is still
 *                                               there, with the link forward
 *                                               and the reason it changed
 *
 * Run it:
 *   node examples/supersession/demo.mjs
 *
 * Writes to a throwaway data dir under the OS temp directory; touches nothing
 * in ~/.groundfloor. Requires Node 22 and a built tree (`npm run build`).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

// Quiet the library's boot chatter so the demo reads as a story rather than a
// log. Set before the dynamic import below, because the log level is read at
// module load. Nothing here changes what Lore does — only what it prints.
process.env.LORE_LOG_LEVEL ??= 'error';

const BOOT_NOISE = /^\[(Lore MCP|audit-export|outbox replicator|VerbatimStore)\]/;
const quiet = (real) => (...args) => {
    if (typeof args[0] === 'string' && BOOT_NOISE.test(args[0])) return;
    real(...args);
};
console.log = quiet(console.log.bind(console));
console.error = quiet(console.error.bind(console));

const { createLore } = await import('../../dist/lore/src/index.js');

const WORKSPACE = 'default';
const ECOSYSTEM = 'payments-api';
const QUESTION = 'How long do session tokens stay valid?';

/* ── tiny presentation helpers — the demo is meant to be watched ────────── */

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const OFF = '\x1b[0m';

/** Pacing. 1 = run fast (tests/CI). Raise it for a watchable recording:
 *  `DEMO_PACE=4 node examples/supersession/demo.mjs` */
const PACE = Number(process.env.DEMO_PACE ?? 1) || 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * PACE));

function step(n, text) {
    console.log(`\n${BOLD}${CYAN}[${n}]${OFF} ${BOLD}${text}${OFF}`);
}

function say(text) {
    console.log(`    ${text}`);
}

/** Keep a line on one terminal row so the demo doesn't reflow when recorded. */
function fit(text, width = 92) {
    return text.length <= width ? text : `${text.slice(0, width - 1).trimEnd()}…`;
}

function agentAsks() {
    console.log(`\n    ${DIM}agent asks:${OFF} ${YELLOW}"${QUESTION}"${OFF}`);
}

/**
 * Print what the agent actually gets back, one line per result.
 *
 * `mode: 'full'` returns `knowledge[]`; summary mode returns `hits[]`. Neither
 * carries the supersession flags, so the graph is consulted for those — which
 * is the honest shape of the API, not a demo shortcut.
 */
async function showResults(result, graph, { expectCount } = {}) {
    const rows = result.knowledge ?? result.hits ?? [];
    if (rows.length === 0) {
        console.log(`    ${RED}(nothing)${OFF}`);
        return rows;
    }
    for (const r of rows) {
        const node = await graph.getNode(r.id);
        const superseded = Boolean(node?.supersededBy);
        const mark = superseded ? `${RED}✗ superseded${OFF}` : `${GREEN}✓ current${OFF}`;
        console.log(`    ${mark}  ${BOLD}${r.label ?? r.id}${OFF}`);
        const body = fit((r.content ?? r.snippet ?? '').split('\n')[0]);
        if (body) console.log(`                 ${DIM}${body}${OFF}`);
        if (superseded) {
            console.log(`                 ${DIM}→ replaced by ${node.supersededBy}${OFF}`);
        }
    }
    if (expectCount != null && rows.length !== expectCount) {
        console.log(`    ${RED}(demo expected ${expectCount} result(s), got ${rows.length})${OFF}`);
    }
    return rows;
}

/* ── the demo ───────────────────────────────────────────────────────────── */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-supersession-'));
process.env.LORE_HOME = dataDir;

const lore = await createLore({ deploymentMode: 'embedded', dataDir });
const graph = lore._daemon.getGraph();

try {
    console.log(`\n${BOLD}Lore — supersession demo${OFF}`);
    console.log(`${DIM}A decision changes. The agent should get the new answer, not both.${OFF}`);

    /* 1 ─ the original decision ------------------------------------------ */

    step(1, 'March. The team sets a session-token policy.');

    await lore.nodeUpsert({
        id: 'decision-session-ttl-v1',
        workspace: WORKSPACE,
        ecosystem: ECOSYSTEM,
        nodeData: {
            id: 'decision-session-ttl-v1',
            ecosystem: ECOSYSTEM,
            type: 'decision',
            label: 'Session tokens expire after 30 days',
            content:
                'Session tokens are valid for 30 days. Chosen to reduce re-login friction '
                + 'for the mobile app, which cannot use silent refresh.',
            tags: ['auth', 'session'],
        },
        asyncEmbed: false,
    });
    await lore.awaitEmbeds();
    say(`${GREEN}stored${OFF} ${DIM}decision-session-ttl-v1${OFF}`);

    agentAsks();
    await showResults(
        await lore.recall(QUESTION, { workspace: WORKSPACE, ecosystem: ECOSYSTEM, mode: 'full' }),
        graph,
        { expectCount: 1 },
    );
    await sleep(600);

    /* 2 ─ the decision changes ------------------------------------------- */

    step(2, 'June. A security review overturns it.');

    await lore.nodeUpsert({
        id: 'decision-session-ttl-v2',
        workspace: WORKSPACE,
        ecosystem: ECOSYSTEM,
        nodeData: {
            id: 'decision-session-ttl-v2',
            ecosystem: ECOSYSTEM,
            type: 'decision',
            label: 'Session tokens expire after 24 hours',
            content:
                'Session tokens are valid for 24 hours. The mobile app now supports silent '
                + 'refresh, so the 30-day window is no longer justified.',
            tags: ['auth', 'session'],
        },
        asyncEmbed: false,
    });
    await lore.awaitEmbeds();
    say(`${GREEN}stored${OFF} ${DIM}decision-session-ttl-v2${OFF}`);

    say(`${DIM}Both decisions are now in the store. This is the moment a rules file breaks:${OFF}`);
    say(`${DIM}it holds both sentences, and nothing in it says which one won.${OFF}`);
    await sleep(600);

    /* 3 ─ declare the supersession --------------------------------------- */

    step(3, 'Someone says so, explicitly. Lore never guesses this.');

    const superseded = await graph.supersedeNode(
        'decision-session-ttl-v1',
        'decision-session-ttl-v2',
        'Security review 2026-06: silent refresh shipped, long-lived tokens no longer justified',
    );
    if (!superseded?.ok) throw new Error(`supersede failed: ${superseded?.reason}`);
    say(`${GREEN}superseded${OFF} ${DIM}v1 → v2, with a reason on the record${OFF}`);
    await sleep(600);

    /* 4 ─ ask the same question ------------------------------------------ */

    step(4, 'The same question. The same agent. One answer now.');

    agentAsks();
    const now = await showResults(
        await lore.recall(QUESTION, { workspace: WORKSPACE, ecosystem: ECOSYSTEM, mode: 'full' }),
        graph,
        { expectCount: 1 },
    );
    await sleep(600);

    /* 5 ─ the history is still there ------------------------------------- */

    step(5, 'Nothing was deleted. Ask for the history and it is all still there.');

    console.log(`\n    ${DIM}same call, includeSuperseded: true${OFF}`);
    await showResults(
        await lore.recall(QUESTION, {
            workspace: WORKSPACE,
            ecosystem: ECOSYSTEM,
            mode: 'full',
            includeSuperseded: true,
        }),
        graph,
    );

    const old = await graph.getNode('decision-session-ttl-v1');
    if (old?.supersededReason) {
        console.log(`\n    ${DIM}why it changed:${OFF} ${old.supersededReason}`);
    }

    console.log(
        `\n${BOLD}${GREEN}That is the whole idea.${OFF}\n`
        + `${DIM}A rules file would still be holding both sentences.${OFF}\n`,
    );

    if (now.length !== 1) process.exitCode = 1;
} finally {
    await lore.dispose('demo complete');
    fs.rmSync(dataDir, { recursive: true, force: true });
}
