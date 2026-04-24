/**
 * mock-dataplane.ts — In-memory mock of the Groundfloor Dataplane HTTP API.
 *
 * Purpose:
 *   The Q2.2 DataplaneGraph adapter speaks to `groundfloor-ts-sdk`, which
 *   in turn speaks HTTP to a Rust Dataplane engine. Spinning up a real
 *   engine per e2e is expensive and brittle. This mock implements just
 *   enough of the engine's REST surface that DataplaneGraph roundtrips
 *   cleanly: createCollection, insert, get, query (with id_eq filter),
 *   updateByQuery, deleteByQuery, count, graph.createEdge, graph.traverse.
 *
 * Tenant isolation:
 *   Records are keyed by (tenantId, collection). Different tenants see
 *   separate collection state even for the same name — exactly like the
 *   real engine. Used by Q2.2 e2e to prove X-Lore-Workspace routes each
 *   request to the right tenant bucket.
 *
 * Envelopes:
 *   Some endpoints use the Rust engine's `ApiResponse` envelope
 *   ({ success, data, error }); others return raw. The mock mirrors the
 *   exact shapes the SDK expects — see the inline comment on each route.
 *
 * Not a full simulator:
 *   Filter matching is intentionally minimal. It understands:
 *     - `id_eq: "..."` — exact id match
 *     - `org_id: "..."` — exact org_id match
 *     - `type: "..."`, `project: "..."`, `ecosystem: "..."` — exact
 *     - `label_contains: "..."`, `tags_contains: "..."` — substring
 *   That's the subset DataplaneGraph uses in slice 2. Adding more is
 *   trivial if a future caller needs it.
 */

import http from 'node:http';
import { AddressInfo } from 'node:net';

type Record_ = Record<string, unknown>;

interface Stored {
    records: Record_[];
}

interface Store {
    // Map<tenantId, Map<collectionName, Stored>>
    tenants: Map<string, Map<string, Stored>>;
    edges: Map<string, Array<{ fromId: string; toId: string; edgeCollection: string; properties?: Record_ }>>;
}

export interface MockDataplane {
    url: string;
    close: () => Promise<void>;
    snapshot: () => { tenants: Array<{ tenantId: string; collections: Array<{ name: string; count: number }> }> };
}

function matchesFilter(record: Record_, filter: Record_ | undefined): boolean {
    if (!filter) return true;
    for (const [key, value] of Object.entries(filter)) {
        if (key === 'id_eq') {
            if (record['id'] !== value) return false;
        } else if (key === 'label_contains') {
            const label = String(record['label'] ?? '');
            if (!label.toLowerCase().includes(String(value).toLowerCase())) return false;
        } else if (key === 'tags_contains') {
            const tags = String(record['tags'] ?? '');
            if (!tags.toLowerCase().includes(String(value).toLowerCase())) return false;
        } else {
            // exact match on top-level field
            if (record[key] !== value) return false;
        }
    }
    return true;
}

async function readJson(req: http.IncomingMessage): Promise<Record_> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw) as Record_);
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/**
 * startMockDataplane — Launch an in-memory Dataplane on a random free port.
 * Call `.close()` in test teardown.
 */
export async function startMockDataplane(): Promise<MockDataplane> {
    const store: Store = { tenants: new Map(), edges: new Map() };

    function getTenant(tenantId: string): Map<string, Stored> {
        let t = store.tenants.get(tenantId);
        if (!t) {
            t = new Map();
            store.tenants.set(tenantId, t);
        }
        return t;
    }
    function getCollection(tenantId: string, name: string): Stored {
        const t = getTenant(tenantId);
        let c = t.get(name);
        if (!c) {
            c = { records: [] };
            t.set(name, c);
        }
        return c;
    }

    const server = http.createServer(async (req, res) => {
        try {
            const url = req.url ?? '/';
            const method = req.method ?? 'GET';
            // All paths follow /v1/{tenant}/{...}
            const match = url.match(/^\/v1\/([^\/\?]+)(\/.*)?$/);
            if (!match) {
                sendJson(res, 404, { error: 'not found' });
                return;
            }
            const tenantId = decodeURIComponent(match[1] ?? '');
            const rest = (match[2] ?? '').replace(/\?.*$/, ''); // strip query string

            // POST /v1/{tenant}/schema — createCollection
            if (rest === '/schema' && method === 'POST') {
                const body = await readJson(req);
                const collName = String(body['name'] ?? '');
                getCollection(tenantId, collName); // materialize
                sendJson(res, 200, body);
                return;
            }

            // Collection-scoped routes: /v1/{tenant}/{collection}/...
            const collMatch = rest.match(/^\/([^\/]+)(\/.*)?$/);
            if (!collMatch) {
                sendJson(res, 404, { error: 'not found' });
                return;
            }
            const collection = decodeURIComponent(collMatch[1] ?? '');
            const sub = collMatch[2] ?? '';

            // POST /v1/{tenant}/{coll}/query
            if (sub === '/query' && method === 'POST') {
                const body = await readJson(req);
                const filter = body['filter'] as Record_ | undefined;
                const limit = typeof body['limit'] === 'number' ? (body['limit'] as number) : 100;
                const store_ = getCollection(tenantId, collection);
                const matched = store_.records.filter((r) => matchesFilter(r, filter));
                sendJson(res, 200, {
                    records: matched.slice(0, limit),
                    total_count: matched.length,
                    has_more: matched.length > limit,
                });
                return;
            }

            // POST /v1/{tenant}/{coll}/count — envelope { success, data: { count } }
            if (sub === '/count' && method === 'POST') {
                const body = await readJson(req);
                const filter = body['filter'] as Record_ | undefined;
                const store_ = getCollection(tenantId, collection);
                const n = store_.records.filter((r) => matchesFilter(r, filter)).length;
                sendJson(res, 200, { success: true, data: { count: n }, error: null });
                return;
            }

            // PUT /v1/{tenant}/{coll}/update-by-query — envelope { success, data: { updated } }
            if (sub === '/update-by-query' && method === 'PUT') {
                const body = await readJson(req);
                const filter = body['filter'] as Record_ | undefined;
                const fields = (body['fields'] ?? {}) as Record_;
                const store_ = getCollection(tenantId, collection);
                let updated = 0;
                for (const rec of store_.records) {
                    if (matchesFilter(rec, filter)) {
                        Object.assign(rec, fields);
                        updated++;
                    }
                }
                sendJson(res, 200, { success: true, data: { updated }, error: null });
                return;
            }

            // DELETE /v1/{tenant}/{coll}/delete-by-query — envelope { success, data: { deleted } }
            if (sub === '/delete-by-query' && method === 'DELETE') {
                const body = await readJson(req);
                const filter = body['filter'] as Record_ | undefined;
                const store_ = getCollection(tenantId, collection);
                const before = store_.records.length;
                store_.records = store_.records.filter((r) => !matchesFilter(r, filter));
                const deleted = before - store_.records.length;
                sendJson(res, 200, { success: true, data: { deleted }, error: null });
                return;
            }

            // POST /v1/{tenant}/{coll}/graph/edge — envelope { success, data: { edge_id } }
            if (sub === '/graph/edge' && method === 'POST') {
                const body = await readJson(req);
                const edges = store.edges.get(tenantId) ?? [];
                const edge_id = `edge_${edges.length + 1}`;
                edges.push({
                    fromId: String(body['from_id'] ?? ''),
                    toId: String(body['to_id'] ?? ''),
                    edgeCollection: String(body['edge_collection'] ?? ''),
                    properties: body['properties'] as Record_ | undefined,
                });
                store.edges.set(tenantId, edges);
                sendJson(res, 200, { success: true, data: { edge_id }, error: null });
                return;
            }

            // POST /v1/{tenant}/{coll}/graph/traverse — envelope { success, data: { records } }
            if (sub === '/graph/traverse' && method === 'POST') {
                const body = await readJson(req);
                const startId = String(body['start_id'] ?? '').replace(/^.*\//, ''); // strip "coll/"
                const edges = store.edges.get(tenantId) ?? [];
                const neighbours = edges.filter((e) => {
                    const fromBare = e.fromId.replace(/^.*\//, '');
                    const toBare = e.toId.replace(/^.*\//, '');
                    return fromBare === startId || toBare === startId;
                });
                const nodeStore = getCollection(tenantId, collection);
                const records: Record_[] = [];
                for (const edge of neighbours) {
                    const fromBare = edge.fromId.replace(/^.*\//, '');
                    const toBare = edge.toId.replace(/^.*\//, '');
                    const otherId = fromBare === startId ? toBare : fromBare;
                    const node = nodeStore.records.find((r) => r['id'] === otherId);
                    if (node) records.push({ ...node, relation: (edge.properties?.['relation'] ?? '') as string, _depth: 1 });
                }
                sendJson(res, 200, { success: true, data: { records }, error: null });
                return;
            }

            // GET /v1/{tenant}/{coll}/{id}
            if (method === 'GET' && sub.startsWith('/')) {
                const id = decodeURIComponent(sub.slice(1));
                const store_ = getCollection(tenantId, collection);
                const rec = store_.records.find((r) => r['id'] === id);
                if (!rec) {
                    sendJson(res, 404, { error: 'not found' });
                    return;
                }
                sendJson(res, 200, rec);
                return;
            }

            // POST /v1/{tenant}/{coll} — insert single record (raw shape, not envelope)
            if (sub === '' && method === 'POST') {
                const body = await readJson(req);
                const store_ = getCollection(tenantId, collection);
                store_.records.push(body);
                sendJson(res, 200, body);
                return;
            }

            sendJson(res, 404, { error: `no handler for ${method} ${rest}` });
        } catch (err) {
            sendJson(res, 500, { error: (err as Error).message });
        }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;

    return {
        url,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
            }),
        snapshot: () => ({
            tenants: Array.from(store.tenants.entries()).map(([tenantId, colls]) => ({
                tenantId,
                collections: Array.from(colls.entries()).map(([name, s]) => ({ name, count: s.records.length })),
            })),
        }),
    };
}
