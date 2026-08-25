#!/usr/bin/env tsx
/**
 * test/webhook-receiver-unit.ts — A3 unit tests
 */

import { strict as assert } from 'node:assert';
import {
    WebhookReceiver,
    signWebhook,
    type WebhookAuditEvent,
} from '../packages/lore/src/engines/webhookReceiver.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; },
        );
}

const SECRET = 'super-secret-test-key';

function headers(body: string, deliveryId = 'd-1'): Record<string, string> {
    return {
        'x-lore-signature': signWebhook(SECRET, body),
        'x-lore-delivery': deliveryId,
    };
}

async function main() {
    console.log('webhook receiver — A3');

    /* ---------- registration ---------- */

    await test('register + listSources + unregister', () => {
        const r = new WebhookReceiver();
        r.register('gmail', { secret: SECRET, handler: async () => { /* noop */ } });
        assert.deepEqual(r.listSources(), ['gmail']);
        assert.equal(r.unregister('gmail'), true);
        assert.equal(r.unregister('gmail'), false);
        assert.deepEqual(r.listSources(), []);
    });

    await test('register rejects duplicate source', () => {
        const r = new WebhookReceiver();
        r.register('gmail', { secret: SECRET, handler: async () => { /* noop */ } });
        assert.throws(() => r.register('gmail', { secret: SECRET, handler: async () => { /* noop */ } }), /already registered/);
    });

    await test('register requires source + secret', () => {
        const r = new WebhookReceiver();
        assert.throws(() => r.register('', { secret: SECRET, handler: async () => { /* noop */ } }), /source/);
        assert.throws(() => r.register('gmail', { secret: '', handler: async () => { /* noop */ } }), /secret/);
    });

    /* ---------- happy path ---------- */

    await test('valid request: 202, handler invoked, audit emits received + accepted', async () => {
        const events: WebhookAuditEvent[] = [];
        const calls: unknown[] = [];
        const r = new WebhookReceiver();
        r.addAuditListener(e => events.push(e));
        r.register('gmail', {
            secret: SECRET,
            handler: async (payload) => { calls.push(payload); },
        });
        const body = JSON.stringify({ message: 'new email' });
        const result = await r.receive({ source: 'gmail', rawBody: body, headers: headers(body) });
        assert.equal(result.status, 202);
        assert.equal(result.body.ok, true);
        assert.equal(calls.length, 1);
        assert.deepEqual(events.map(e => e.kind), ['received', 'accepted']);
    });

    /* ---------- failure paths ---------- */

    await test('unknown source: 404 + audit rejected', async () => {
        const events: WebhookAuditEvent[] = [];
        const r = new WebhookReceiver();
        r.addAuditListener(e => events.push(e));
        const result = await r.receive({ source: 'made-up', rawBody: '{}', headers: {} });
        assert.equal(result.status, 404);
        assert.equal(events[0].kind, 'rejected');
        if (events[0].kind === 'rejected') assert.equal(events[0].reason, 'unknown-source');
    });

    await test('missing signature: 401', async () => {
        const r = new WebhookReceiver();
        r.register('gmail', { secret: SECRET, handler: async () => { /* noop */ } });
        const body = '{}';
        const result = await r.receive({ source: 'gmail', rawBody: body, headers: { 'x-lore-delivery': 'd-1' } });
        assert.equal(result.status, 401);
    });

    await test('wrong signature: 401', async () => {
        const r = new WebhookReceiver();
        r.register('gmail', { secret: SECRET, handler: async () => { /* noop */ } });
        const body = '{}';
        const result = await r.receive({
            source: 'gmail', rawBody: body,
            headers: { 'x-lore-signature': 'sha256=tampered', 'x-lore-delivery': 'd-1' },
        });
        assert.equal(result.status, 401);
    });

    await test('signature checked over raw body, not parsed', async () => {
        const r = new WebhookReceiver();
        let received: unknown = null;
        r.register('gmail', { secret: SECRET, handler: async (p) => { received = p; } });
        const original = '{"a":1, "b":  2}';
        const tampered = '{"a":1,"b":2}'; // re-stringified — different bytes, signature would differ
        const result = await r.receive({
            source: 'gmail', rawBody: original,
            headers: { 'x-lore-signature': signWebhook(SECRET, tampered), 'x-lore-delivery': 'd-1' },
        });
        assert.equal(result.status, 401, 'signature on different bytes should fail');
        assert.equal(received, null);
    });

    await test('missing delivery-id: 400', async () => {
        const r = new WebhookReceiver();
        r.register('gmail', { secret: SECRET, handler: async () => { /* noop */ } });
        const body = '{}';
        const result = await r.receive({
            source: 'gmail', rawBody: body,
            headers: { 'x-lore-signature': signWebhook(SECRET, body) },
        });
        assert.equal(result.status, 400);
    });

    await test('malformed JSON: 400', async () => {
        const r = new WebhookReceiver();
        r.register('gmail', { secret: SECRET, handler: async () => { /* noop */ } });
        const body = '{not json';
        const result = await r.receive({ source: 'gmail', rawBody: body, headers: headers(body) });
        assert.equal(result.status, 400);
    });

    await test('handler throws: 500 + audit rejected handler-error; not idempotency-marked', async () => {
        const events: WebhookAuditEvent[] = [];
        const r = new WebhookReceiver();
        r.addAuditListener(e => events.push(e));
        let calls = 0;
        r.register('gmail', {
            secret: SECRET,
            handler: async () => { calls++; throw new Error('boom'); },
        });
        const body = '{"x":1}';
        const result1 = await r.receive({ source: 'gmail', rawBody: body, headers: headers(body) });
        assert.equal(result1.status, 500);
        // Retry with same delivery-id should hit handler again (not marked).
        const result2 = await r.receive({ source: 'gmail', rawBody: body, headers: headers(body) });
        assert.equal(result2.status, 500);
        assert.equal(calls, 2);
        const rejected = events.filter(e => e.kind === 'rejected');
        assert.ok(rejected.length >= 2);
    });

    /* ---------- idempotency ---------- */

    await test('duplicate delivery: returns 200 + audit duplicate; handler not re-invoked', async () => {
        const events: WebhookAuditEvent[] = [];
        const r = new WebhookReceiver();
        r.addAuditListener(e => events.push(e));
        let calls = 0;
        r.register('gmail', {
            secret: SECRET,
            handler: async () => { calls++; },
        });
        const body = '{"x":1}';
        const r1 = await r.receive({ source: 'gmail', rawBody: body, headers: headers(body, 'd-1') });
        const r2 = await r.receive({ source: 'gmail', rawBody: body, headers: headers(body, 'd-1') });
        assert.equal(r1.status, 202);
        assert.equal(r2.status, 200);
        assert.equal(r2.body.reason, 'duplicate');
        assert.equal(calls, 1);
        assert.ok(events.some(e => e.kind === 'duplicate'));
    });

    await test('idempotency is per-source — same delivery-id across sources is not a dup', async () => {
        const r = new WebhookReceiver();
        let gmailCalls = 0;
        let calCalls = 0;
        r.register('gmail', { secret: SECRET, handler: async () => { gmailCalls++; } });
        r.register('gcal', { secret: SECRET, handler: async () => { calCalls++; } });
        const body = '{}';
        await r.receive({ source: 'gmail', rawBody: body, headers: headers(body, 'shared-id') });
        await r.receive({ source: 'gcal', rawBody: body, headers: headers(body, 'shared-id') });
        assert.equal(gmailCalls, 1);
        assert.equal(calCalls, 1);
    });

    /* ---------- listener errors ---------- */

    await test('audit listener throwing does not break receive', async () => {
        const r = new WebhookReceiver();
        r.addAuditListener(() => { throw new Error('listener boom'); });
        r.register('gmail', { secret: SECRET, handler: async () => { /* noop */ } });
        const body = '{}';
        const result = await r.receive({ source: 'gmail', rawBody: body, headers: headers(body) });
        assert.equal(result.status, 202);
    });

    /* ---------- custom headers ---------- */

    await test('custom signature/delivery header names work', async () => {
        const r = new WebhookReceiver();
        r.register('custom', {
            secret: SECRET,
            signatureHeader: 'x-custom-sig',
            deliveryIdHeader: 'x-custom-id',
            handler: async () => { /* noop */ },
        });
        const body = '{"a":1}';
        const result = await r.receive({
            source: 'custom', rawBody: body,
            headers: {
                'x-custom-sig': signWebhook(SECRET, body),
                'x-custom-id': 'd-99',
            },
        });
        assert.equal(result.status, 202);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('test runner crashed:', err);
    process.exit(1);
});
