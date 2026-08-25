#!/usr/bin/env tsx
/**
 * lifecycle-shutdown-unit.ts — verifies startHttpLifecycle wires the
 * optional onShutdown callback correctly:
 *
 *   - onShutdown is invoked on SIGINT / SIGTERM, before httpServer.close
 *   - the hook is idempotent (only invoked once if both signals fire)
 *   - a throwing onShutdown is logged but does not block close + exit
 *
 * We don't actually let the lifecycle call process.exit (that would
 * kill the test runner). Instead we stub process.exit + emit signals
 * synthetically.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startHttpLifecycle } from '../packages/lore/src/mcp/lifecycle.js';

interface FakeServer extends EventEmitter {
    _listening: boolean;
    _closed: boolean;
    _lastListenArgs: unknown[];
    listen(...args: unknown[]): void;
    close(): void;
}

function fakeServer(): FakeServer {
    const ee = new EventEmitter() as FakeServer;
    ee._listening = false;
    ee._closed = false;
    ee._lastListenArgs = [];
    ee.listen = function (...args: unknown[]) {
        this._listening = true;
        this._lastListenArgs = args;
        // The 3rd arg is the listen callback in our usage. Fire it.
        const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined;
        cb?.();
    };
    ee.close = function () { this._closed = true; };
    return ee;
}

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

// Stub process.exit + process.on so each test runs in isolation.
const realExit = process.exit;
const realOn = process.on.bind(process);
const realRemove = process.removeAllListeners.bind(process);
let exitCalls: number[] = [];
(process.exit as unknown as (code?: number) => void) = (code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`__exit:${code ?? 0}__`);
};

function runShutdownVia(signal: 'SIGINT' | 'SIGTERM'): void {
    try { (process as unknown as EventEmitter).emit(signal); } catch (e) {
        if (!(e as Error).message?.startsWith('__exit:')) throw e;
    }
}

function setup() {
    realRemove('SIGINT');
    realRemove('SIGTERM');
    exitCalls = [];
}

console.log('startHttpLifecycle — onShutdown wiring');

test('onShutdown fires on SIGINT, BEFORE httpServer.close', () => {
    setup();
    const httpServer = fakeServer();
    const order: string[] = [];
    startHttpLifecycle({
        httpServer: httpServer as unknown as import('node:http').Server,
        port: 0, graphBasePath: '/tmp', detectedScope: { project: '*', ecosystem: '*' },
        onShutdown: () => { order.push('hook'); },
    });
    httpServer.close = function () { order.push('close'); this._closed = true; };
    runShutdownVia('SIGINT');
    assert.deepEqual(order, ['hook', 'close']);
});

test('onShutdown fires on SIGTERM too', () => {
    setup();
    const httpServer = fakeServer();
    let calls = 0;
    startHttpLifecycle({
        httpServer: httpServer as unknown as import('node:http').Server,
        port: 0, graphBasePath: '/tmp', detectedScope: { project: '*', ecosystem: '*' },
        onShutdown: () => { calls++; },
    });
    runShutdownVia('SIGTERM');
    assert.equal(calls, 1);
});

test('idempotent: both signals → onShutdown invoked only once', () => {
    setup();
    const httpServer = fakeServer();
    let calls = 0;
    startHttpLifecycle({
        httpServer: httpServer as unknown as import('node:http').Server,
        port: 0, graphBasePath: '/tmp', detectedScope: { project: '*', ecosystem: '*' },
        onShutdown: () => { calls++; },
    });
    runShutdownVia('SIGINT');
    runShutdownVia('SIGTERM');
    assert.equal(calls, 1, 'shutdown hook must not double-fire');
});

test('throwing onShutdown is caught + httpServer.close still runs', () => {
    setup();
    const httpServer = fakeServer();
    let closed = false;
    startHttpLifecycle({
        httpServer: httpServer as unknown as import('node:http').Server,
        port: 0, graphBasePath: '/tmp', detectedScope: { project: '*', ecosystem: '*' },
        onShutdown: () => { throw new Error('boom'); },
    });
    httpServer.close = () => { closed = true; };
    runShutdownVia('SIGINT');
    assert.equal(closed, true);
});

test('omitted onShutdown is fine (no hook)', () => {
    setup();
    const httpServer = fakeServer();
    startHttpLifecycle({
        httpServer: httpServer as unknown as import('node:http').Server,
        port: 0, graphBasePath: '/tmp', detectedScope: { project: '*', ecosystem: '*' },
    });
    let closed = false;
    httpServer.close = () => { closed = true; };
    runShutdownVia('SIGINT');
    assert.equal(closed, true);
});

// Restore.
(process.exit as unknown as typeof realExit) = realExit;
process.on = realOn;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
