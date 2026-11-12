/**
 * workload.ts - the fixed seed + operation list of the golden baseline. Drives Lore's PUBLIC embedded API only
 * (`createLore()` handle + `lore.store.storageClient` + the per-workspace graph handle from `lore._daemon`), in a fixed
 * sequential order, and returns one plain object that the runner normalises and compares to a committed snapshot.
 *
 * Every id, tag, type and text is fixed; nothing here reads the clock or random numbers.
 */
import type { EmbeddingProvider } from '../../packages/lore/src/providers/types.js';
import { runWithActor } from '../../packages/lore/src/security/actorContext.js';

export const WS_A = 'golden-a';
export const WS_B = 'golden-b';

/** Deterministic 16-dim embedder (same pattern as test/embedded-ingestion-e2e.ts DetEmbedProvider). */
export class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 16;
    readonly modelId = 'golden-baseline-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(t: string): Promise<number[]> { return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocumentBatch(ts: string[]): Promise<number[][]> { return ts.map((t) => this.vec(t)); }
}

type Any = any;
type Seed = { id: string; type: string; label: string; content: string; tags: string; scopes?: string[] };

const TYPES = ['decision', 'convention', 'note', 'bug_pattern', 'architecture'];
const TAG_SETS = ['Alpha,beta', 'ALPHA,Gamma', 'beta', 'Gamma,delta', 'Release-Notes,alpha'];
const TOPICS = ['lease renewal', 'invoice approval', 'tenant onboarding', 'maintenance schedule', 'budget forecast', 'vendor contract'];

/** 30 generated nodes for A (a-01..a-30) + 8 for B (b-01..b-08); the hand-written ones are added in {@link seed}. */
function generated(): Array<{ ws: string; seed: Seed }> {
    const out: Array<{ ws: string; seed: Seed }> = [];
    for (let i = 1; i <= 30; i++) {
        const n = String(i).padStart(2, '0');
        out.push({ ws: WS_A, seed: {
            id: `a-${n}`, type: TYPES[i % TYPES.length]!, label: `A item ${n}`,
            content: `Golden note ${n} about ${TOPICS[i % TOPICS.length]} in building ${(i * 7) % 5}.`,
            tags: TAG_SETS[i % TAG_SETS.length]!,
            ...(i % 10 === 0 ? { scopes: ['team-x'] } : {}),
        } });
    }
    for (let i = 1; i <= 8; i++) {
        const n = String(i).padStart(2, '0');
        out.push({ ws: WS_B, seed: {
            id: `b-${n}`, type: TYPES[(i + 2) % TYPES.length]!, label: `B item ${n}`,
            content: `Workspace B memo ${n} about ${TOPICS[(i + 3) % TOPICS.length]}.`, tags: TAG_SETS[(i + 1) % TAG_SETS.length]!,
        } });
    }
    return out;
}

/** Distinct wall-clock ms between writes whose version-history order is by timestamp. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/** Run one operation; capture the value, or the error shape (a thrown error is part of the contract). */
async function cap(fn: () => Promise<unknown>): Promise<unknown> {
    try { return { ok: true, value: await fn() }; } catch (e) {
        const err = e as Any;
        return { threw: { name: err?.name ?? 'Error', code: err?.code ?? null, message: String(err?.message ?? e) } };
    }
}

/** A verbatim doc by id; a tombstone's text embeds a wall-clock ISO time (and so its contentHash varies): redact both. */
function vdoc(d: Any): unknown {
    if (!d || typeof d.text !== 'string') return d;
    const text = d.text.replace(/\[TOMBSTONED [^ ]+ /, '[TOMBSTONED <ts> ');
    return text === d.text ? d : { ...d, text, contentHash: '<tombstone-hash>' };
}

/** A write result with the thrown/returned Error object flattened (Error objects serialise to {}). */
function flatten(r: Any): unknown {
    if (r && r.ok === false && r.error) {
        const { error, ...rest } = r;
        return { ...rest, error: { name: error.name ?? 'Error', code: error.code ?? null, message: String(error.message ?? '') } };
    }
    return r;
}

/**
 * Wait until every background write has landed: embeds finished and no pending outbox rows in either workspace.
 * Without this, search/recall race the replicator and rankings vary run to run (observed on the first attempt).
 */
async function settle(lore: Any): Promise<void> {
    const store = lore._daemon.outboxWiring.store;
    const deadline = Date.now() + 30_000;
    for (;;) {
        await lore.awaitEmbeds();
        // listUnfinished() sees failed rows still waiting to retry. Each run owns its own Lore instance, so wait for ALL
        // unfinished rows (no workspace filter: outbox rows are keyed by name on sqlite, by permanent id on postgres).
        const pending = (await store.listUnfinished()).length;
        if (pending === 0) break;
        if (Date.now() > deadline) throw new Error(`golden workload: ${pending} outbox rows still pending after 30s`);
        await new Promise((r) => setTimeout(r, 50));
    }
    await lore.awaitEmbeds();
}

export interface WorkloadHandles { lore: Any }

/**
 * The workload. `lore` must have workspaces WS_A and WS_B registered (open.ts does that). Returns the raw (un-normalised)
 * capture; ordering of the returned keys is irrelevant (the snapshot writer sorts keys).
 */
export async function runWorkload({ lore }: WorkloadHandles): Promise<Record<string, unknown>> {
    const sc = lore.store.storageClient;
    const reg = lore._daemon.getGraphRegistry();
    const graph = async (ws: string): Promise<Any> => reg.getGraphHandle(ws);
    const R: Record<string, unknown> = {};

    const put = async (ws: string, s: Seed, extra: Record<string, unknown> = {}, nodeExtra: Record<string, unknown> = {}): Promise<unknown> => flatten(await lore.nodeUpsert({
        id: s.id, workspace: ws, ecosystem: '*', autolink: false,
        nodeData: { id: s.id, type: s.type, label: s.label, content: s.content, tags: s.tags, project: ws, ecosystem: '*', ...(s.scopes ? { security_scopes: s.scopes } : {}), ...nodeExtra },
        ...extra,
    }));

    // ---- seed -------------------------------------------------------------------------------------------------------
    const seedResults: Record<string, unknown> = {};
    for (const { ws, seed } of generated()) seedResults[`${ws}/${seed.id}`] = await put(ws, seed);
    // Hub + spokes for graph neighbours, and a supersedes chain v1 <- v2 <- v3.
    const hand: Seed[] = [
        { id: 'hub', type: 'architecture', label: 'Hub node', content: 'Central hub of the golden graph.', tags: 'Alpha,hub' },
        { id: 'spoke-1', type: 'note', label: 'Spoke one', content: 'First spoke attached to the hub.', tags: 'hub' },
        { id: 'spoke-2', type: 'decision', label: 'Spoke two', content: 'Second spoke attached to the hub, a decision hub link.', tags: 'Hub' },
        { id: 'spoke-3', type: 'convention', label: 'Spoke three', content: 'Third spoke, reached through spoke two.', tags: 'hub,beta' },
        { id: 'pol-v1', type: 'decision', label: 'Retention policy v1', content: 'Keep records for three years.', tags: 'policy' },
    ];
    for (const s of hand) seedResults[`${WS_A}/${s.id}`] = await put(WS_A, s);
    seedResults[`${WS_A}/pol-v2`] = await put(WS_A, { id: 'pol-v2', type: 'decision', label: 'Retention policy v2', content: 'Keep records for five years.', tags: 'policy' }, { supersedes: ['pol-v1'] });
    seedResults[`${WS_A}/pol-v3`] = await put(WS_A, { id: 'pol-v3', type: 'decision', label: 'Retention policy v3', content: 'Keep records for seven years.', tags: 'policy' }, { supersedes: ['pol-v2'] });
    // The same id in the other workspace: isolation must keep them apart.
    seedResults[`${WS_B}/hub`] = await put(WS_B, { id: 'hub', type: 'note', label: 'B hub', content: 'Hub in workspace B only.', tags: 'b-only' });
    R['seed'] = seedResults;

    const gA = await graph(WS_A);
    const edgeResults: unknown[] = [];
    for (const [s, t, rel] of [['hub', 'spoke-1', 'related_to'], ['hub', 'spoke-2', 'related_to'], ['spoke-2', 'spoke-3', 'depends_on'], ['a-01', 'a-02', 'applies_to'], ['a-05', 'hub', 'caused_by']] as const) {
        edgeResults.push({ edge: `${s} ${rel} ${t}`, result: await cap(async () => { await gA.addEdge({ sourceId: s, targetId: t, relation: rel, confidence: 'extracted', confidenceScore: 1 }); return 'added'; }) });
    }
    R['edges.add'] = edgeResults;
    await settle(lore);

    // ---- conditional writes (3.33) ----------------------------------------------------------------------------------
    const cond: Record<string, unknown> = {};
    const cs = (id: string, label: string): Seed => ({ id, type: 'note', label, content: `${label} body`, tags: 'cond' });
    cond['ifAbsent.create'] = await put(WS_A, cs('cond-1', 'cond one'), { ifAbsent: true });
    const cond1First = (await sc.getNode('cond-1', { workspace: WS_A }))?.createdAt;
    await tick();
    cond['ifAbsent.exists'] = await put(WS_A, cs('cond-1', 'cond one again'), { ifAbsent: true });
    await tick();
    cond['ifRevision.match'] = await put(WS_A, cs('cond-1', 'cond one v2'), { ifRevision: 1 });
    await tick();
    cond['ifRevision.mismatch'] = await put(WS_A, cs('cond-1', 'cond one v3'), { ifRevision: 1 });
    cond['ifRevision.onMissing'] = await put(WS_A, cs('cond-nope', 'never'), { ifRevision: 3 });
    await tick();
    cond['ifRevision.invalid'] = await put(WS_A, cs('cond-1', 'bad'), { ifRevision: -2 });
    await new Promise((r) => setTimeout(r, 10)); // strictly later wall-clock ms for the updatedAt > createdAt check
    cond['unconditional.bumpRevision'] = await put(WS_A, cs('cond-1', 'cond one v4'));
    cond['getNode.afterConditional'] = await cap(() => sc.getNode('cond-1', { workspace: WS_A }));
    const cond1Last = await sc.getNode('cond-1', { workspace: WS_A });
    // Timestamp contract, as booleans (the normaliser rewrites every ISO string to <ts>, so values are checked here).
    const tsOf = (s: unknown): number => Date.parse(String(s));
    R['timestamps.cond-1'] = {
        createdAtUnchangedAcrossWrites: !!cond1First && cond1First === cond1Last?.createdAt,
        updatedAtAfterCreatedAt: tsOf(cond1Last?.updatedAt) > tsOf(cond1Last?.createdAt),
    };
    // Revision history of cond-1 (the version store behind getVersions); order as returned, volatile fields normalised.
    cond['versionHistory cond-1'] = await cap(async () => lore._daemon.versionStore?.getVersions('cond-1', WS_A, 50) ?? 'no-version-store');
    // One bulk write (bulkIngest), the embedded handle's bulk path.
    cond['bulkIngest 3 nodes'] = await cap(async () => lore.bulkIngest([1, 2, 3].map((i) => ({ id: `bulk-${i}`, workspace: WS_A, ecosystem: '*', nodeData: { id: `bulk-${i}`, type: 'note', label: `Bulk ${i}`, content: `Bulk ingested note ${i} about forecast.`, tags: 'bulk', project: WS_A, ecosystem: '*' } })), { embed: 'sync', autolink: false }));
    R['conditional'] = cond;

    // ---- error shapes -----------------------------------------------------------------------------------------------
    const errs: Record<string, unknown> = {};
    errs['pathlike_node_id_accepted'] = await put(WS_A, { id: '../evil', type: 'note', label: 'x', content: 'x', tags: '' });
    errs['unknown_workspace.write'] = await cap(async () => flatten(await lore.nodeUpsert({ id: 'x', workspace: 'no-such-ws', ecosystem: '*', nodeData: { id: 'x', type: 'note', label: 'x', content: 'x' } })));
    errs['unknown_workspace.read'] = await cap(() => sc.getNode('hub', { workspace: 'no-such-ws' }));
    errs['supersedes.missing_target'] = await put(WS_A, { id: 'ghost-sup', type: 'decision', label: 'ghost', content: 'supersedes a node that does not exist', tags: '' }, { supersedes: ['does-not-exist'] });
    errs['supersedes.already_superseded'] = await put(WS_A, { id: 'pol-v4', type: 'decision', label: 'v4', content: 'supersedes an already superseded node', tags: 'policy' }, { supersedes: ['pol-v1'] });
    R['errors'] = errs;
    await settle(lore);

    // ---- reads ------------------------------------------------------------------------------------------------------
    const reads: Record<string, unknown> = {};
    for (const [ws, id] of [[WS_A, 'a-01'], [WS_A, 'hub'], [WS_B, 'hub'], [WS_A, 'pol-v1'], [WS_A, 'a-10'], [WS_A, 'b-01'], [WS_B, 'a-01'], [WS_A, 'missing']] as const) {
        reads[`getNode ${ws}/${id}`] = await cap(() => sc.getNode(id, { workspace: ws }));
    }
    R['getNode'] = reads;
    const p1 = await sc.getNode('pol-v1', { workspace: WS_A }); const p2 = await sc.getNode('pol-v2', { workspace: WS_A });
    R['timestamps.pol'] = {
        pol1SupersededAtSet: !!p1?.supersededAt,
        pol1SupersededNotBeforePol2Created: tsOf(p1?.supersededAt) >= tsOf(p2?.createdAt),
        pol2SupersededAtSet: !!p2?.supersededAt,
    };

    // listNodes: the API promises no order, so results are sorted by id (documented per field).
    const byId = (a: Any[]): Any[] => [...a].sort((x, y) => String(x.id).localeCompare(String(y.id)));
    const list: Record<string, unknown> = {};
    const L = (type?: string, tag?: string, ws = WS_A): Promise<unknown> => cap(async () => byId(await sc.listNodes(type, tag, '*', '*', undefined, { unbounded: true, workspace: ws })).map((n) => ({ id: n.id, type: n.type, tags: n.tags, supersededBy: n.supersededBy ?? null })));
    list['all A (sorted by id)'] = await L();
    list['all B (sorted by id)'] = await L(undefined, undefined, WS_B);
    list['type=decision'] = await L('decision');
    list['type=architecture'] = await L('architecture');
    list['tag=alpha'] = await L(undefined, 'alpha');
    list['tag=Alpha (mixed-case query)'] = await L(undefined, 'Alpha');
    list['tag=hub'] = await L(undefined, 'hub');
    list['type=note+tag=beta'] = await L('note', 'beta');
    list['tag=nothing'] = await L(undefined, 'nothing-has-this');
    R['listNodes'] = list;

    // Keyword + vector search (ranked: order is part of the contract, NOT sorted).
    // Whole hit objects, so a score change or any new field on a hit shows up as a diff. Engine rank order is KEPT. The only
    // reordering: among CONSECUTIVE hits that carry a score and whose 4-dp scores are EQUAL, ids are sorted (that relative
    // order is a tie-break, not contract). Hits without a score (LoreNode results of sc.search / lore.search) are never
    // reordered, so their rank is asserted as returned.
    const score4 = (n: Any): number | null => { const v = n?.score ?? n?.similarity; return typeof v === 'number' ? Math.round(v * 1e4) : null; };
    const slim = (a: Any[]): unknown => {
        const out: Any[] = [];
        for (let i = 0; i < a.length;) {
            const s = score4(a[i]);
            let j = i + 1;
            if (s !== null) while (j < a.length && score4(a[j]) === s) j++;
            out.push(...a.slice(i, j).sort((x, y) => String(x.id).localeCompare(String(y.id))));
            i = j;
        }
        return out;
    };
    const search: Record<string, unknown> = {};
    search['storageClient.search lease A'] = await cap(async () => slim(await sc.search('lease renewal', 10, '*', '*', { workspace: WS_A })));
    search['storageClient.search central hub A'] = await cap(async () => slim(await sc.search('Central hub of the golden graph', 10, '*', '*', { workspace: WS_A })));
    search['storageClient.search hub B (isolation)'] = await cap(async () => slim(await sc.search('hub', 10, '*', '*', { workspace: WS_B })));
    search['lore.search invoice A'] = await cap(async () => slim(await lore.search('invoice approval', 8, WS_A)));
    search['lore.search no match'] = await cap(async () => slim(await sc.search('zzzqqq-nothing', 5, '*', '*', { workspace: WS_A })));
    search['verbatimSearch vendor A'] = await cap(async () => slim(await sc.verbatimSearch('vendor contract', 5, undefined, { workspace: WS_A })));
    R['search'] = search;

    const recall: Record<string, unknown> = {};
    const rc = (q: string, o: Record<string, unknown>): Promise<unknown> => cap(async () => lore.recall(q, { mode: 'full', ...o }));
    recall['A lease'] = await rc('lease renewal for the building', { workspace: WS_A });
    recall['A depth2 hub'] = await rc('central hub', { workspace: WS_A, depth: 2 });
    recall['A tags=alpha'] = await rc('golden note', { workspace: WS_A, tags: ['alpha'] });
    recall['A types=decision'] = await rc('retention policy', { workspace: WS_A, types: ['decision'] });
    recall['A retention (superseded hidden)'] = await rc('retention policy records', { workspace: WS_A });
    recall['A retention includeSuperseded'] = await rc('retention policy records', { workspace: WS_A, includeSuperseded: true });
    recall['B hub (isolation)'] = await rc('hub', { workspace: WS_B });
    recall['cross-workspace *'] = await rc('hub node', { workspace: '*' });
    recall['summary mode'] = await rc('maintenance schedule', { workspace: WS_A, mode: 'summary' });
    recall['unknown workspace'] = await rc('hub', { workspace: 'no-such-ws' });
    R['recall'] = recall;

    // Scope filtering: the same reads as an actor with no scopes and as one holding team-x (a-10/a-20/a-30 carry team-x).
    const scoped: Record<string, unknown> = {};
    for (const scopes of [[], ['team-x']] as string[][]) {
        const k = `scopes=[${scopes.join(',')}]`;
        const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor({ portalUserId: 'golden', scopes }, fn);
        scoped[`${k} getNode a-10`] = await cap(() => as(() => sc.getNode('a-10', { workspace: WS_A })));
        scoped[`${k} listNodes (ids)`] = await cap(() => as(async () => byId(await sc.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true, workspace: WS_A })).map((n) => n.id)));
        scoped[`${k} recall`] = await cap(() => as(() => lore.recall('lease renewal', { mode: 'full', workspace: WS_A })));
        scoped[`${k} search`] = await cap(() => as(async () => slim(await sc.search('lease renewal', 5, '*', '*', { workspace: WS_A }))));
    }
    scoped['write team-x under actor [team-x]'] = await put2(lore, WS_A, 'scoped-w', ['team-x'], ['team-x']);
    scoped['write team-x under actor []'] = await put2(lore, WS_A, 'scoped-w2', ['team-x'], []);
    R['scopes'] = scoped;
    await settle(lore);

    // Graph: traverse / queryEdges / neighbours are order-unspecified, sorted below with a stable key.
    const graphOps: Record<string, unknown> = {};
    const sortBy = (a: Any[], f: (x: Any) => string): Any[] => [...a].sort((x, y) => f(x).localeCompare(f(y)));
    graphOps['traverse hub depth1'] = await cap(async () => sortBy(await gA.traverse('hub', 1), (x) => JSON.stringify(x)));
    graphOps['traverse hub depth2'] = await cap(async () => sortBy(await gA.traverse('hub', 2), (x) => JSON.stringify(x)));
    graphOps['traverse hub depends_on only'] = await cap(async () => sortBy(await gA.traverse('spoke-2', 2, 'depends_on'), (x) => JSON.stringify(x)));
    graphOps['traverse missing'] = await cap(async () => gA.traverse('nope', 1));
    graphOps['queryEdges all A'] = await cap(async () => sortBy(await gA.queryEdges({ limit: 100, offset: 0 }), (e) => `${e.sourceId}|${e.relation}|${e.targetId}`));
    graphOps['queryEdges source=hub'] = await cap(async () => sortBy(await gA.queryEdges({ source: 'hub', limit: 100, offset: 0 }), (e) => `${e.sourceId}|${e.relation}|${e.targetId}`));
    graphOps['queryEdges B'] = await cap(async () => (await (await graph(WS_B)).queryEdges({ limit: 100, offset: 0 })));
    // neighbors1Hop(id, ecosystem='*') returns row sets whose order is not in the contract: sorted by id.
    graphOps['neighbors1Hop hub'] = await cap(async () => {
        const r = await gA.neighbors1Hop?.('hub');
        const norm = (x: Any): Any => ({ ...x, outRows: byId(x?.outRows ?? []), inRows: byId(x?.inRows ?? []) });
        return Array.isArray(r) ? r.map(norm) : norm(r);
    });
    graphOps['queryEdges source=hub includeProvenance'] = await cap(async () => sortBy(await gA.queryEdges({ source: 'hub', limit: 100, offset: 0, includeProvenance: true }), (e) => `${e.sourceId}|${e.relation}|${e.targetId}`));
    graphOps['getEdge hub->spoke-1 includeProvenance'] = await cap(async () => gA.getEdge('hub', 'spoke-1', 'related_to', { includeProvenance: true }));
    graphOps['getEdge hub->spoke-1'] = await cap(async () => gA.getEdge('hub', 'spoke-1', 'related_to'));
    R['graph'] = graphOps;

    const stats: Record<string, unknown> = {};
    stats['getStats A'] = await cap(() => sc.getStats(undefined, { workspace: WS_A }));
    stats['getStats B'] = await cap(() => sc.getStats(undefined, { workspace: WS_B }));
    stats['verbatimCount A'] = await cap(() => sc.verbatimCount({ workspace: WS_A }));
    stats['verbatimCount B'] = await cap(() => sc.verbatimCount({ workspace: WS_B }));
    R['stats'] = stats;

    // ---- delete -----------------------------------------------------------------------------------------------------
    const del: Record<string, unknown> = {};
    del['search spoke before'] = await cap(async () => slim(await sc.search('Third spoke', 5, '*', '*', { workspace: WS_A })));
    // Query = the exact verbatim text of spoke-3 (label, content, tags), so lore:spoke-3 is the top hit before the delete.
    const spoke3Text = 'Spoke three\n\nThird spoke, reached through spoke two.\n\nhub,beta';
    const vA = await (sc as Any).vFor(WS_A);
    del['verbatimSearch spoke before'] = await cap(async () => slim(await sc.verbatimSearch(spoke3Text, 3, undefined, { workspace: WS_A })));
    del['verbatim doc lore:spoke-3 before'] = await cap(async () => vdoc(await vA.getById('lore:spoke-3')));
    del['verbatimCount A before'] = await cap(() => sc.verbatimCount({ workspace: WS_A }));
    del['verbatimCount B before'] = await cap(() => sc.verbatimCount({ workspace: WS_B }));
    del['nodeDelete spoke-3'] = await cap(() => lore.nodeDelete({ id: 'spoke-3', workspace: WS_A }));
    del['nodeDelete spoke-3 again'] = await cap(() => lore.nodeDelete({ id: 'spoke-3', workspace: WS_A }));
    del['nodeDelete wrong workspace'] = await cap(() => lore.nodeDelete({ id: 'a-02', workspace: WS_B }));
    del['nodeDelete unknown ws'] = await cap(() => lore.nodeDelete({ id: 'a-02', workspace: 'no-such-ws' }));
    await settle(lore);
    del['getNode spoke-3'] = await cap(() => sc.getNode('spoke-3', { workspace: WS_A }));
    del['getNode a-02 still in A'] = await cap(async () => (await sc.getNode('a-02', { workspace: WS_A }))?.id ?? null);
    del['queryEdges source=spoke-2 after'] = await cap(async () => sortBy(await gA.queryEdges({ source: 'spoke-2', limit: 100, offset: 0 }), (e) => `${e.sourceId}|${e.relation}|${e.targetId}`));
    del['getStats A after'] = await cap(() => sc.getStats(undefined, { workspace: WS_A }));
    del['search spoke after'] = await cap(async () => slim(await sc.search('Third spoke', 5, '*', '*', { workspace: WS_A })));
    del['verbatimSearch spoke after'] = await cap(async () => slim(await sc.verbatimSearch(spoke3Text, 3, undefined, { workspace: WS_A })));
    del['verbatim doc lore:spoke-3 after'] = await cap(async () => vdoc(await vA.getById('lore:spoke-3')));
    del['verbatimCount A after'] = await cap(() => sc.verbatimCount({ workspace: WS_A }));
    del['nodeDeleteMany a-27,a-28,missing'] = await cap(() => lore.nodeDeleteMany({ ids: ['a-27', 'a-28', 'never-existed'], workspace: WS_A }));
    await settle(lore);
    del['verbatimCount A after deleteMany'] = await cap(() => sc.verbatimCount({ workspace: WS_A }));
    del['getStats A after deleteMany'] = await cap(() => sc.getStats(undefined, { workspace: WS_A }));
    del['versionHistory spoke-3 after delete'] = await cap(async () => lore._daemon.versionStore?.getVersions('spoke-3', WS_A, 50) ?? 'no-version-store');
    await settle(lore);
    R['delete'] = del;

    // ---- hard erase: nodeDelete({ purge: true }) on a dedicated node ------------------------------------------------------
    // FIXED (2026-11-11): purge removes the node, verbatim doc + #rev history AND the version-store rows (node_versions),
    // so `after.versionHistory` is empty. Plain delete keeps versions (see `delete` above).
    const purge: Record<string, unknown> = {};
    const purgeText = 'Purge target\n\nZebrafish quartz marmalade erasure canary. Second revision.\n\npurge';
    purge['seed'] = await put(WS_A, { id: 'purge-1', type: 'note', label: 'Purge target', content: 'Zebrafish quartz marmalade erasure canary.', tags: 'purge' });
    await tick();
    purge['seed rewrite (history row)'] = await put(WS_A, { id: 'purge-1', type: 'note', label: 'Purge target', content: 'Zebrafish quartz marmalade erasure canary. Second revision.', tags: 'purge' });
    await settle(lore);
    const snap = async (): Promise<unknown> => ({
        getNode: await cap(() => sc.getNode('purge-1', { workspace: WS_A })),
        verbatimDoc: await cap(async () => vdoc(await vA.getById('lore:purge-1'))),
        verbatimHistory: await cap(() => vA.getHistory?.('lore:purge-1') ?? 'no-getHistory'),
        verbatimSearchContent: await cap(async () => slim(await sc.verbatimSearch(purgeText, 3, undefined, { workspace: WS_A }))),
        versionHistory: await cap(async () => lore._daemon.versionStore?.getVersions('purge-1', WS_A, 50) ?? 'no-version-store'),
        verbatimCount: await cap(() => sc.verbatimCount({ workspace: WS_A })),
    });
    purge['before'] = await snap();
    purge['nodeDelete purge'] = await cap(() => lore.nodeDelete({ id: 'purge-1', workspace: WS_A, purge: true }));
    await settle(lore);
    purge['after'] = await snap();
    R['purge'] = purge;

    // ---- logical export: the full node set + full edge set of each workspace, sorted by id / edge key -----------------
    const exp: Record<string, unknown> = {};
    for (const ws of [WS_A, WS_B]) {
        exp[ws] = await cap(async () => ({
            nodes: byId(await sc.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true, workspace: ws })),
            edges: sortBy(await (await graph(ws)).queryEdges({ limit: 1000, offset: 0 }), (e) => `${e.sourceId}|${e.relation}|${e.targetId}`),
        }));
    }
    R['export'] = exp;
    return R;
}

/** A write of a team-x node under an actor with the given scopes. */
async function put2(lore: Any, ws: string, id: string, nodeScopes: string[], actorScopes: string[]): Promise<unknown> {
    return cap(() => runWithActor({ portalUserId: 'golden', scopes: actorScopes }, async () => flatten(await lore.nodeUpsert({
        id, workspace: ws, ecosystem: '*', autolink: false,
        nodeData: { id, type: 'note', label: id, content: `${id} scoped body`, tags: 'scoped', project: ws, ecosystem: '*', security_scopes: nodeScopes },
    }))));
}
