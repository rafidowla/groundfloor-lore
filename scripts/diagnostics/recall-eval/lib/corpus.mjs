/**
 * corpus.mjs — deterministic synthetic-corpus generator for the recall-eval
 * fixture. Everything here is ORIGINAL content about a made-up software
 * project ("Riverstone", a job-orchestration platform). Nothing is copied
 * from Atlas or the atlas-recall-eval reference directory — only the
 * *shape* (curated knowledge vs. chatty notes vs. code rows, near-duplicate
 * knowledge, hub nodes with many edges) is mirrored.
 *
 * All randomness goes through lib/rng.mjs's seeded PRNG so the generated
 * corpus — and therefore the node ids questions.json refers to — is
 * byte-identical across runs and machines.
 */

import { makeRng, pick, pickN, intBetween } from './rng.mjs';
import { ANCHORS } from './anchors.mjs';

export const FIXTURE_SEED = 'riverstone-fixture-v1';
export const WORKSPACE = 'default';
export const ECOSYSTEM = 'riverstone';

const COMPONENTS = [
    'scheduler', 'worker-pool', 'lease-manager', 'checkpoint-store', 'connector-bus',
    'tenant-router', 'retry-policy', 'dead-letter-queue', 'rate-limiter', 'config-loader',
    'metrics-exporter', 'webhook-relay', 'job-table', 'outbox', 'audit-log', 'cli',
];

const VERBS = ['dispatch', 'renew', 'flush', 'drain', 'reconcile', 'rebalance', 'purge', 'validate', 'throttle', 'replay'];
const NOUNS = ['batch window', 'shard map', 'fencing token', 'backoff curve', 'watermark', 'circuit breaker', 'quota ledger', 'snapshot', 'offset cursor', 'health probe'];
const REASONS = [
    'to cut tail latency under burst load',
    'because the previous approach caused duplicate work under failover',
    'to keep memory bounded on long-lived processes',
    'after a production incident traced to an unbounded retry loop',
    'to make the behavior consistent across all three deployment regions',
    'because a customer audit required an explicit, testable guarantee',
    'to avoid a lock contention hot spot found under load testing',
    'to make the component independently deployable from the rest of the stack',
];
const KNOWLEDGE_TYPES = ['decision', 'convention', 'architecture', 'bug_pattern'];

function titleCase(s) {
    return s.replace(/(^|[-\s])(\w)/g, (_, p, c) => p + c.toUpperCase());
}

/** ~42 plain filler knowledge nodes, template-generated, deterministic. */
function buildFillerKnowledge(rng) {
    const out = [];
    for (let i = 0; i < 42; i++) {
        const type = KNOWLEDGE_TYPES[i % KNOWLEDGE_TYPES.length];
        const component = pick(rng, COMPONENTS);
        const verb = pick(rng, VERBS);
        const noun = pick(rng, NOUNS);
        const reason = pick(rng, REASONS);
        const id = `fx-filler-${type}-${String(i).padStart(3, '0')}`;
        const label = `${titleCase(component)} ${verb} behavior tied to its ${noun}`;
        const content = `The ${component} component's ${verb} path was adjusted with respect to its ${noun} ${reason}. This is tracked as a ${type} for the Riverstone platform and reviewed each quarter alongside the other ${component} notes.`;
        out.push({
            id, type, label, content,
            tags: [type, component, 'filler'],
            project: 'riverstone',
        });
    }
    return out;
}

/** 6 near-duplicate pairs (12 nodes) — paraphrases of each other, not of any anchor. */
function buildNearDuplicates(rng) {
    const pairs = [
        {
            topic: 'batch-size-tuning',
            a: 'The scheduler\'s default batch dispatch size is 64 jobs per tick, tuned to balance dispatch overhead against per-job scheduling latency on the interactive tier.',
            b: 'Dispatch batches default to 64 jobs each tick in the scheduler; this size was picked to trade off per-tick overhead against latency for interactive-tier jobs.',
        },
        {
            topic: 'connector-timeout-default',
            a: 'Outbound connector calls from the connector-bus time out after 8 seconds by default, matching the slowest first-party downstream system\'s documented SLA.',
            b: 'The connector-bus applies an 8 second default timeout to outbound calls, chosen to match the slowest first-party downstream\'s SLA commitment.',
        },
        {
            topic: 'audit-log-immutability',
            a: 'Entries written to the audit-log are append-only and never updated in place; a correction is recorded as a new entry referencing the one it corrects.',
            b: 'The audit-log never mutates an existing entry; corrections are always new append-only entries that reference the original entry they correct.',
        },
        {
            topic: 'cli-auth-token-scope',
            a: 'The Riverstone CLI issues short-lived auth tokens scoped to a single tenant and a single command invocation, expiring after 10 minutes.',
            b: 'CLI auth tokens are short-lived, scoped to one tenant and one invocation, and expire 10 minutes after issue.',
        },
        {
            topic: 'worker-pool-min-size',
            a: 'The worker pool never scales below a floor of 3 warm workers per region, even during the lowest-traffic overnight window, to avoid cold-start latency on the first job.',
            b: 'A floor of 3 warm workers per region is always kept in the worker pool, including overnight, so the first job of a burst never pays cold-start latency.',
        },
        {
            topic: 'retry-budget-cap',
            a: 'A job\'s total retry budget across its lifetime is capped at 12 attempts regardless of which retry policy is attached to it, as a global safety ceiling.',
            b: 'Regardless of the retry policy attached, every job has a hard lifetime cap of 12 retry attempts as a platform-wide safety ceiling.',
        },
    ];
    const out = [];
    for (const p of pairs) {
        out.push({
            id: `fx-dup-${p.topic}-a`, type: 'convention', label: `${titleCase(p.topic.replace(/-/g, ' '))} (variant A)`,
            content: p.a, tags: ['convention', 'near-duplicate', p.topic], project: 'riverstone',
        });
        out.push({
            id: `fx-dup-${p.topic}-b`, type: 'convention', label: `${titleCase(p.topic.replace(/-/g, ' '))} (variant B)`,
            content: p.b, tags: ['convention', 'near-duplicate', p.topic], project: 'riverstone',
        });
    }
    return out;
}

/** 2 hub nodes intended to accumulate many graph edges (D4 context). */
function buildHubNodes() {
    return [
        {
            id: 'fx-hub-system-overview',
            type: 'architecture',
            label: 'Riverstone system overview',
            content: 'Riverstone is a multi-tenant job-orchestration platform composed of a scheduler, worker pool, lease manager, checkpoint store, connector bus, tenant router, rate limiter, config loader, metrics exporter, and webhook relay, all coordinating through a shared job table and outbox.',
            tags: ['architecture', 'overview', 'hub'],
            project: 'riverstone',
        },
        {
            id: 'fx-hub-glossary',
            type: 'convention',
            label: 'Riverstone platform glossary',
            content: 'Shared vocabulary across Riverstone teams: a "lease" is a time-boxed claim a worker holds on a job; a "tick" is one scheduler dispatch cycle; a "fencing token" invalidates a stale worker\'s writes; a "tier" is a scheduler priority class.',
            tags: ['convention', 'glossary', 'hub'],
            project: 'riverstone',
        },
    ];
}

/** ~300 chatty captured notes — casual, low-signal, higher noise than knowledge nodes. */
function buildChatNotes(rng, count = 300) {
    const openers = ['quick note:', 'fyi —', 'heads up,', 'random thought:', 'reminder to self:', 'from standup:', 'saw this in the logs:', 'chatting with the team,'];
    const fillers = [
        'not sure this matters but worth a look later.',
        'someone should double check this before next release.',
        'might just be noise, keeping an eye on it.',
        'came up again this week, second time this month.',
        'low priority, parking here for now.',
        'related to something we discussed in the sync.',
        'probably fine, just documenting for later.',
        'worth revisiting once the current sprint wraps up.',
    ];
    const out = [];
    for (let i = 0; i < count; i++) {
        const component = pick(rng, COMPONENTS);
        const verb = pick(rng, VERBS);
        const opener = pick(rng, openers);
        const filler = pick(rng, fillers);
        const extraComponents = pickN(rng, COMPONENTS, intBetween(rng, 0, 2)).filter((c) => c !== component);
        const extra = extraComponents.length ? ` Also touches ${extraComponents.join(' and ')}.` : '';
        const id = `fx-note-${String(i).padStart(4, '0')}`;
        const content = `${opener} noticed the ${component} ${verb} path acting a little different today, ${filler}${extra}`;
        out.push({
            id, type: 'note', label: `Chat note ${i}`,
            content, tags: ['note', component], project: 'riverstone',
        });
    }
    return out;
}

const CODE_VERBS = ['dispatch', 'renew', 'flush', 'drain', 'reconcile', 'rebalance', 'purge', 'validate', 'throttle', 'replay', 'serialize', 'hydrate'];
const CODE_NOUNS = ['Batch', 'Lease', 'Checkpoint', 'Shard', 'Token', 'Offset', 'Snapshot', 'Cursor', 'Probe', 'Ledger'];

/** Code-ish rows: default 10k, flag for 100k. Deliberately generic/low-signal text. */
function buildCodeRows(rng, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const component = COMPONENTS[i % COMPONENTS.length];
        const verb = pick(rng, CODE_VERBS);
        const noun = pick(rng, CODE_NOUNS);
        const symbol = `${verb}${noun}`;
        const id = `fx-code-${String(i).padStart(6, '0')}`;
        const filePath = `src/${component}/${symbol}.ts`;
        const content = `export function ${symbol}(ctx: Context): Promise<Result> {\n  // ${component} ${verb} path, auto-generated fixture symbol #${i}\n  return ctx.${component.replace(/-/g, '_')}.${verb}();\n}`;
        out.push({
            id, type: 'code_symbol', label: `${symbol} (${filePath})`,
            content, tags: ['code', component], project: 'riverstone', filePath,
        });
    }
    return out;
}

/**
 * Build the full deterministic corpus.
 * @param {{codeRowCount?: number}} opts
 */
export function buildCorpus(opts = {}) {
    const codeRowCount = opts.codeRowCount ?? 10000;
    const rng = makeRng(FIXTURE_SEED);

    const knowledgeNodes = [
        ...ANCHORS.map((a) => ({ id: a.id, type: a.type, label: a.label, content: a.content, tags: a.tags, project: 'riverstone' })),
        ...buildFillerKnowledge(rng),
        ...buildNearDuplicates(rng),
        ...buildHubNodes(),
    ];
    const notes = buildChatNotes(rng, 300);
    const codeRows = buildCodeRows(rng, codeRowCount);

    // Hub edges: connect each hub node to ~18 other knowledge nodes (D4 context).
    const nonHubIds = knowledgeNodes.filter((n) => !n.id.startsWith('fx-hub-')).map((n) => n.id);
    const hubRng = makeRng(FIXTURE_SEED + '-edges');
    const edges = [];
    for (const hub of ['fx-hub-system-overview', 'fx-hub-glossary']) {
        const targets = pickN(hubRng, nonHubIds, 18);
        for (const targetId of targets) {
            edges.push({
                sourceId: hub, targetId, relation: 'relates_to',
                confidence: 'inferred', confidenceScore: 0.6,
            });
        }
    }

    return {
        workspace: WORKSPACE,
        ecosystem: ECOSYSTEM,
        knowledgeNodes,
        notes,
        codeRows,
        edges,
        counts: {
            knowledge: knowledgeNodes.length,
            notes: notes.length,
            code: codeRows.length,
            edges: edges.length,
        },
    };
}
