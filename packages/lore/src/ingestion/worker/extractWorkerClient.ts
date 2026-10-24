/**
 * ingestion/worker/extractWorkerClient.ts - owns the forked extractor child and speaks to it over IPC.
 *
 * Isolation: the extractors parse untrusted files with native add-ons (canvas, sharp, tesseract/wasm, ffmpeg). A
 * crash, an out-of-memory abort or a hang there must cost one job attempt, never the host. So every call has a
 * deadline; on a timeout the child is killed (SIGKILL) and the call fails RETRYABLE; if the child exits mid-call the
 * call fails retryable and the next call spawns a fresh child. The coordinator then retries the SAME job id with
 * backoff and dead-letters after maxAttempts. One file is in the child at a time.
 *
 * The child is started lazily on the first call (an idle host has no extra process) and `dispose()` kills it and
 * waits for it to exit. Its environment is an allowlist, not the host's: no tokens or keys pass to a file parser.
 */
import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtractedContent } from '../../engines/extractors/types.js';
import { ProcessorError } from '../contracts.js';
import {
    WORKER_READY_TIMEOUT_MS, type ChildToParent, type ExtractTransport, type WireExtractRequest, type WireVisionConfig, type WorkerInit,
} from './extractWorkerProtocol.js';

export interface ExtractWorkerClientOptions {
    vision: WireVisionConfig | null;
    maxFileBytes: number;
    /** V8 old-space limit for the child (--max-old-space-size) and, with headroom, its RSS recycle threshold. */
    maxMemoryMb: number;
    /** Deadline for one extraction. */
    timeoutMs: number;
    readyTimeoutMs?: number;
    /** LORE_HOME the child should use (it must resolve the same home as the host). */
    home?: string;
    /** Test hook: a different child entry file (a fixture that crashes or hangs on demand). */
    entry?: string;
    /** Test hook: RSS recycle threshold in MB. Default is derived from maxMemoryMb. */
    recycleRssMb?: number;
}

const ENV_ALLOW = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'LORE_HOME', 'LORE_MODEL_SERVER', 'LORE_OCR_LANGUAGES', 'LORE_WHISPER_BIN'];

/** The child's environment: an allowlist of the host's variables (plus tsx's own when the host runs under it). */
export function workerEnv(parent: NodeJS.ProcessEnv, home?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const k of Object.keys(parent)) if (ENV_ALLOW.includes(k) || k.startsWith('TSX_')) env[k] = parent[k];
    if (home) env['LORE_HOME'] = home;
    return env;
}

function defaultEntry(): string {
    const here = fileURLToPath(import.meta.url);
    return path.join(path.dirname(here), 'extractWorkerEntry' + path.extname(here));
}

interface Inflight { id: number; resolve: (c: ExtractedContent) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class ExtractWorkerClient implements ExtractTransport {
    readonly kind = 'child' as const;
    private child: ChildProcess | null = null;
    private starting: Promise<ChildProcess> | null = null;
    private inflight: Inflight | null = null;
    private chain: Promise<unknown> = Promise.resolve();
    private nextId = 1;
    private closed = false;

    constructor(private readonly o: ExtractWorkerClientOptions) {}

    /** pid of the live child, if any (tests and diagnostics). */
    get pid(): number | undefined { return this.child && this.child.exitCode === null && this.child.signalCode === null ? this.child.pid : undefined; }

    extract(req: { jobId: string; mimeType: string; fileName: string; bytes: Buffer }): Promise<ExtractedContent> {
        const run = this.chain.then(() => this.call(req));
        this.chain = run.catch(() => undefined);
        return run;
    }

    private async call(req: { jobId: string; mimeType: string; fileName: string; bytes: Buffer }): Promise<ExtractedContent> {
        if (this.closed) throw new ProcessorError('extract worker is stopped', true);
        const child = await this.ensure();
        const id = this.nextId++;
        return new Promise<ExtractedContent>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.inflight = null;
                try { child.kill('SIGKILL'); } catch { /* already gone */ }
                reject(new ProcessorError(`extraction timed out after ${this.o.timeoutMs}ms; worker killed`, true));
            }, this.o.timeoutMs);
            this.inflight = { id, resolve, reject, timer };
            const msg: WireExtractRequest = { type: 'extract', id, jobId: req.jobId, mimeType: req.mimeType, fileName: req.fileName, bytes: req.bytes };
            child.send(msg, (err) => {
                if (err && this.inflight?.id === id) { clearTimeout(timer); this.inflight = null; reject(new ProcessorError(`could not reach the extract worker: ${err.message}`, true)); }
            });
        });
    }

    private ensure(): Promise<ChildProcess> {
        if (this.child && this.child.exitCode === null && this.child.signalCode === null && this.child.connected) return Promise.resolve(this.child);
        this.starting ??= this.spawn().finally(() => { this.starting = null; });
        return this.starting;
    }

    private spawn(): Promise<ChildProcess> {
        const maxMb = this.o.maxMemoryMb;
        const execArgv = [...process.execArgv.filter((a) => !a.startsWith('--max-old-space-size')), `--max-old-space-size=${maxMb}`];
        const child = fork(this.o.entry ?? defaultEntry(), [], {
            env: workerEnv(process.env, this.o.home), execArgv, serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        this.child = child;
        child.on('exit', (code, signal) => this.onExit(child, code, signal));
        child.on('error', () => { /* surfaced through exit / the ready timeout */ });
        child.on('message', (raw: unknown) => this.onMessage(raw as ChildToParent));

        return new Promise<ChildProcess>((resolve, reject) => {
            const fail = (why: string) => { clearTimeout(timer); child.off('message', onReady); child.off('exit', onEarlyExit); try { child.kill('SIGKILL'); } catch { /* gone */ } reject(new ProcessorError(`extract worker did not start: ${why}`, true)); };
            const timer = setTimeout(() => fail(`not ready within ${this.o.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS}ms`), this.o.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS);
            const onReady = (raw: unknown) => {
                const m = raw as ChildToParent;
                if (m?.type === 'ready') { clearTimeout(timer); child.off('message', onReady); child.off('exit', onEarlyExit); resolve(child); }
                else if (m?.type === 'init-error') fail(m.message);
            };
            const onEarlyExit = (code: number | null, signal: string | null) => fail(`exited during start (${signal ?? code})`);
            child.on('message', onReady);
            child.once('exit', onEarlyExit);
            const init: WorkerInit = {
                type: 'init', vision: this.o.vision, maxFileBytes: this.o.maxFileBytes,
                recycleRssMb: this.o.recycleRssMb ?? Math.floor(maxMb * 1.5),
            };
            child.send(init);
        });
    }

    private onMessage(m: ChildToParent): void {
        if (!m || (m.type !== 'result' && m.type !== 'error')) return;
        const f = this.inflight;
        if (!f || f.id !== m.id) return; // late answer for a call already failed (timeout): ignore
        clearTimeout(f.timer); this.inflight = null;
        if (m.type === 'result') f.resolve(m.content);
        else f.reject(new ProcessorError(m.error.message, m.error.retryable));
    }

    private onExit(child: ChildProcess, code: number | null, signal: string | null): void {
        if (this.child === child) this.child = null;
        const f = this.inflight;
        if (f) { clearTimeout(f.timer); this.inflight = null; f.reject(new ProcessorError(`extract worker exited mid-job (${signal ?? `code ${code}`})`, true)); }
    }

    async dispose(): Promise<void> {
        this.closed = true;
        const f = this.inflight;
        if (f) { clearTimeout(f.timer); this.inflight = null; f.reject(new ProcessorError('extract worker is stopped', true)); }
        let child = this.child;
        if (!child && this.starting) { try { child = await this.starting; } catch { child = this.child; } }
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 5_000);
            child!.once('exit', () => { clearTimeout(t); resolve(); });
            try { child!.kill('SIGKILL'); } catch { clearTimeout(t); resolve(); }
        });
    }
}
