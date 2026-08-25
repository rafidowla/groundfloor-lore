#!/usr/bin/env tsx
/**
 * test/connector-contract-unit.ts — T2 unit tests
 *
 * Exercises the finalized IConnector contract:
 *   - registry: register, list, listStatus exposes version, get, healthOf
 *     uses defaultHealth fallback or the connector's own implementation
 *   - registry: addAuditListener returns unsubscribe; events fire in
 *     start → item* → complete order on success and start → item* → error
 *     on failure
 *   - filesystem connector: version/getNativeSchema/health all present
 *   - notifyAuthEvent emits auth.connected / auth.disconnected
 *
 * No actual filesystem IO is exercised — we use a stub connector that
 * yields canned items deterministically.
 */

import { strict as assert } from 'node:assert';
import {
    ConnectorRegistry,
} from '../packages/lore/src/engines/connectors/registry.js';
import {
    defaultHealth,
    type ConnectorAuditEvent,
    type ConnectorItem,
    type ConnectorNativeSchema,
    type ConnectorStatus,
    type HealthResult,
    type IConnector,
    type SyncOptions,
} from '../packages/lore/src/engines/connectors/types.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => {
                console.error(`  ✗ ${name}`);
                console.error(`    ${err.message}`);
                failed++;
            },
        );
}

class StubConnector implements IConnector {
    readonly name = 'stub';
    readonly version = '2.0.0';
    readonly displayName = 'Stub';
    readonly description = 'Deterministic test connector.';

    constructor(
        private readonly items: ConnectorItem[] = [],
        private readonly behavior: { authenticated?: boolean; healthOk?: boolean; throwOnIndex?: number } = {},
    ) { }

    isAuthenticated(): boolean {
        return this.behavior.authenticated ?? true;
    }

    getNativeSchema(): ConnectorNativeSchema {
        return {
            types: [{
                name: 'StubRecord',
                description: 'A test record.',
                fields: [
                    { name: 'id', type: 'string', required: true },
                    { name: 'value', type: 'number' },
                ],
            }],
            proposedMapping: { StubRecord: 'know.Note' },
        };
    }

    async health(): Promise<HealthResult> {
        return {
            ok: this.behavior.healthOk ?? true,
            message: this.behavior.healthOk === false ? 'down' : 'reachable',
            lastChecked: new Date().toISOString(),
        };
    }

    async *sync(_opts?: SyncOptions): AsyncIterable<ConnectorItem> {
        for (let i = 0; i < this.items.length; i++) {
            if (this.behavior.throwOnIndex === i) {
                throw new Error(`stub failure at item ${i}`);
            }
            yield this.items[i];
        }
    }

    getStatus(): ConnectorStatus {
        return { connected: this.isAuthenticated() };
    }
}

class NoHealthConnector implements IConnector {
    readonly name = 'no-health';
    readonly version = '0.1.0';
    readonly displayName = 'No-Health';
    readonly description = 'Test connector without health() override.';

    constructor(private readonly authed: boolean = true) { }

    isAuthenticated(): boolean { return this.authed; }
    getNativeSchema(): ConnectorNativeSchema { return { types: [] }; }
    async *sync(): AsyncIterable<ConnectorItem> { /* empty */ }
    getStatus(): ConnectorStatus { return { connected: this.authed }; }
}

function fakeItem(id: string, mime: string, bytes: number): ConnectorItem {
    return {
        sourceId: `stub:${id}`,
        mimeType: mime,
        content: Buffer.alloc(bytes),
        metadata: { id },
        modifiedAt: new Date().toISOString(),
    };
}

async function main() {
    console.log('connector contract — T2');

    /* ---------- registry basics ---------- */

    await test('register + get + list', () => {
        const r = new ConnectorRegistry();
        const c = new StubConnector();
        r.register(c);
        assert.equal(r.get('stub'), c);
        assert.equal(r.list().length, 1);
    });

    await test('register rejects duplicate name', () => {
        const r = new ConnectorRegistry();
        r.register(new StubConnector());
        assert.throws(() => r.register(new StubConnector()), /already registered/);
    });

    await test('listStatus exposes version', () => {
        const r = new ConnectorRegistry();
        r.register(new StubConnector());
        const rows = r.listStatus();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].version, '2.0.0');
        assert.equal(rows[0].status.connected, true);
    });

    /* ---------- health ---------- */

    await test('healthOf uses connector implementation when present', async () => {
        const r = new ConnectorRegistry();
        r.register(new StubConnector([], { healthOk: false }));
        const h = await r.healthOf('stub');
        assert.equal(h.ok, false);
        assert.equal(h.message, 'down');
        assert.ok(typeof h.latencyMs === 'number');
    });

    await test('healthOf falls back to defaultHealth when not implemented', async () => {
        const r = new ConnectorRegistry();
        r.register(new NoHealthConnector(true));
        const h = await r.healthOf('no-health');
        assert.equal(h.ok, true);
        assert.equal(h.message, 'authenticated');
    });

    await test('defaultHealth reflects isAuthenticated', () => {
        const c = new NoHealthConnector(false);
        const h = defaultHealth(c);
        assert.equal(h.ok, false);
        assert.equal(h.message, 'not authenticated');
    });

    /* ---------- audit listener ---------- */

    await test('audit listener: start → item* → complete on success', async () => {
        const r = new ConnectorRegistry();
        r.register(new StubConnector([
            fakeItem('a', 'text/plain', 10),
            fakeItem('b', 'text/plain', 20),
        ]));
        const events: ConnectorAuditEvent[] = [];
        r.addAuditListener((e) => events.push(e));

        const yielded: ConnectorItem[] = [];
        for await (const item of r.syncOne('stub')) yielded.push(item);

        assert.equal(yielded.length, 2);
        assert.equal(events[0].kind, 'sync.start');
        assert.equal(events[1].kind, 'sync.item');
        assert.equal(events[2].kind, 'sync.item');
        assert.equal(events[3].kind, 'sync.complete');
        if (events[3].kind === 'sync.complete') {
            assert.equal(events[3].itemsYielded, 2);
            assert.ok(events[3].durationMs >= 0);
        }
    });

    await test('audit listener: start → item → error when sync throws', async () => {
        const r = new ConnectorRegistry();
        r.register(new StubConnector(
            [fakeItem('a', 'text/plain', 10), fakeItem('b', 'text/plain', 20)],
            { throwOnIndex: 1 },
        ));
        const events: ConnectorAuditEvent[] = [];
        r.addAuditListener((e) => events.push(e));

        const yielded: ConnectorItem[] = [];
        await assert.rejects(async () => {
            for await (const item of r.syncOne('stub')) yielded.push(item);
        }, /stub failure at item 1/);

        assert.equal(yielded.length, 1);
        const last = events[events.length - 1];
        assert.equal(last.kind, 'sync.error');
        if (last.kind === 'sync.error') {
            assert.equal(last.itemsYielded, 1);
            assert.match(last.error, /stub failure/);
        }
    });

    await test('audit listener: unsubscribe stops emissions', async () => {
        const r = new ConnectorRegistry();
        r.register(new StubConnector([fakeItem('a', 'text/plain', 10)]));
        const events: ConnectorAuditEvent[] = [];
        const off = r.addAuditListener((e) => events.push(e));
        off();
        for await (const _ of r.syncOne('stub')) { /* consume */ }
        assert.equal(events.length, 0);
    });

    await test('audit listener: errors thrown by listeners do not break sync', async () => {
        const r = new ConnectorRegistry();
        r.register(new StubConnector([fakeItem('a', 'text/plain', 10)]));
        r.addAuditListener(() => { throw new Error('boom'); });
        const yielded: ConnectorItem[] = [];
        for await (const item of r.syncOne('stub')) yielded.push(item);
        assert.equal(yielded.length, 1);
    });

    /* ---------- auth events ---------- */

    await test('notifyAuthEvent emits auth.connected and auth.disconnected', () => {
        const r = new ConnectorRegistry();
        r.register(new StubConnector());
        const events: ConnectorAuditEvent[] = [];
        r.addAuditListener((e) => events.push(e));
        r.notifyAuthEvent('stub', 'auth.connected');
        r.notifyAuthEvent('stub', 'auth.disconnected');
        assert.equal(events.length, 2);
        assert.equal(events[0].kind, 'auth.connected');
        assert.equal(events[1].kind, 'auth.disconnected');
    });

    /* ---------- native schema ---------- */

    await test('connector exposes native schema with proposed mapping', () => {
        const c = new StubConnector();
        const ns = c.getNativeSchema();
        assert.equal(ns.types.length, 1);
        assert.equal(ns.types[0].name, 'StubRecord');
        assert.equal(ns.proposedMapping?.StubRecord, 'know.Note');
    });

    /* ---------- unknown connector ---------- */

    await test('healthOf throws for unknown connector', async () => {
        const r = new ConnectorRegistry();
        await assert.rejects(() => r.healthOf('nope'), /Unknown connector/);
    });

    await test('syncOne throws for unknown connector', async () => {
        const r = new ConnectorRegistry();
        await assert.rejects(async () => {
            for await (const _ of r.syncOne('nope')) { /* consume */ }
        }, /Unknown connector/);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('test runner crashed:', err);
    process.exit(1);
});
