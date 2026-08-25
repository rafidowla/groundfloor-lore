/**
 * arcadeHttp.ts — HTTP transport for the ArcadeDB db-per-app backend
 * (branch: spike/arcadedb-multitenant). Slice 1 proved the substrate over a
 * naked `fetch`; slice 2 (W6) hardens the transport for a real deploy:
 *
 *   (a) TLS — https:// base URLs with certificate validation ALWAYS ON for
 *       non-localhost. There is NO insecure escape hatch. An optional private
 *       CA is wired via LORE_ARCADE_CA_FILE. Plain http:// is permitted ONLY
 *       for localhost/127.0.0.1 (the test container); a non-localhost http://
 *       base URL fails construction loud.
 *   (b) Keep-alive connection pooling — ONE Node http(s).Agent per baseUrl
 *       (module-level map, keepAlive + bounded maxSockets), shared by every
 *       cell against that server (they're the same host; Basic auth is a
 *       per-request header, not a connection property). Node's built-in Agent
 *       gives real socket reuse without adding an undici dependency.
 *   (c) Request timeouts — a whole-call deadline on every request.
 *   (d) Bounded retries on the IDEMPOTENT QUERY LANE ONLY — query() retries on
 *       network errors + 502/503/504 (max 2 retries, full-jitter backoff).
 *       command() / serverCommand() / commandScript() NEVER retry: mutations
 *       and DDL are not provably idempotent at the transport level; replay
 *       safety lives in the outbox, not the socket.
 *
 * TENANT-SCOPING (unchanged from slice 1): command/query take the database name
 * as their FIRST positional arg and embed it verbatim in the URL path. ArcadeDB
 * has no cross-database primitive, so an op physically cannot address another
 * tenant's db. Adapters above capture `db` ONCE at construction and never take
 * it as a method parameter.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import { URL } from 'node:url';

export interface ArcadeAuth {
  user: string;
  pass: string;
}

export interface ArcadeCommandResult {
  user?: string;
  result: unknown[];
}

/** Typed transport error carrying the HTTP status + raw body for assertions. */
export class ArcadeHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`ArcadeDB HTTP ${status}: ${body}`);
    this.name = 'ArcadeHttpError';
  }
}

function basicAuthHeader(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function isLocalhostHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// ── module-level Agent pool (one per baseUrl, shared across all cells) ──────
//
// The Agent owns the keep-alive socket pool. All cells hitting the same
// ArcadeDB server share ONE Agent — auth differs per request (a header), not
// per connection, so pooling is safe. Keyed by the normalized base origin.
const agentPool = new Map<string, http.Agent | https.Agent>();

const DEFAULT_MAX_CONNECTIONS = 16;
const DEFAULT_TIMEOUT_MS = 30_000;
const QUERY_MAX_RETRIES = 2;
const QUERY_RETRY_BASE_MS = 100;
const QUERY_RETRY_CAP_MS = 400;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

function maxConnections(): number {
  const raw = process.env['LORE_ARCADE_MAX_CONNECTIONS'];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CONNECTIONS;
}

function agentFor(url: URL): http.Agent | https.Agent {
  const key = url.origin;
  const existing = agentPool.get(key);
  if (existing) return existing;
  const common = { keepAlive: true, maxSockets: maxConnections(), maxFreeSockets: 8 };
  let agent: http.Agent | https.Agent;
  if (url.protocol === 'https:') {
    const caFile = process.env['LORE_ARCADE_CA_FILE'];
    agent = new https.Agent({
      ...common,
      // Certificate validation is ALWAYS on — no rejectUnauthorized:false path
      // exists anywhere in this file. An optional private CA is additive.
      ...(caFile ? { ca: fs.readFileSync(caFile) } : {}),
    });
  } else {
    agent = new http.Agent(common);
  }
  agentPool.set(key, agent);
  return agent;
}

/** Test/ops hook — destroy pooled agents (e.g. between test suites). */
export function resetArcadeAgentPool(): void {
  for (const agent of agentPool.values()) agent.destroy();
  agentPool.clear();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * ArcadeHttp — a per-cell HTTP client. Auth credentials captured at
 * construction (one ArcadeDB db-user). `baseUrl` defaults to the local spike
 * container. Constructing with a non-localhost http:// base throws loud.
 */
export class ArcadeHttp {
  private readonly base: URL;
  private readonly timeoutMs: number;

  constructor(
    private auth: ArcadeAuth,
    baseUrl: string = 'http://localhost:2480',
    opts?: { timeoutMs?: number },
  ) {
    const url = new URL(baseUrl);
    if (url.protocol === 'http:' && !isLocalhostHost(url.hostname)) {
      throw new Error(
        `[ArcadeHttp] refusing plaintext http:// to non-localhost host "${url.hostname}". ` +
          `Use https:// (certificate validation is always on; set LORE_ARCADE_CA_FILE ` +
          `for a private CA). Plain http:// is permitted only for localhost.`,
      );
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`[ArcadeHttp] unsupported protocol "${url.protocol}" in base URL ${baseUrl}`);
    }
    this.base = url;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * updateCredentials — swap the Basic-auth credentials in place (used by the
   * secret-store 401-refresh hook + operator credential rotation). Auth is a
   * per-request header, so this doesn't disturb the shared socket pool.
   */
  updateCredentials(auth: ArcadeAuth): void {
    this.auth = auth;
  }

  private request(path: string, body: unknown): Promise<ArcadeCommandResult> {
    const url = new URL(path, this.base);
    const agent = agentFor(url);
    const payload = JSON.stringify(body);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    return new Promise<ArcadeCommandResult>((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method: 'POST',
          agent,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Authorization: basicAuthHeader(this.auth.user, this.auth.pass),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new ArcadeHttpError(status, text));
              return;
            }
            try {
              resolve(text ? (JSON.parse(text) as ArcadeCommandResult) : { result: [] });
            } catch (e) {
              reject(new Error(`[ArcadeHttp] malformed JSON response: ${(e as Error).message}`));
            }
          });
        },
      );
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`[ArcadeHttp] request timeout after ${this.timeoutMs}ms`));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Idempotent read lane — POST /api/v1/query/{db}. Bounded retries on network
   * errors + 502/503/504 (query is side-effect-free, so replay is safe).
   */
  async query(
    db: string,
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<ArcadeCommandResult> {
    const body = { language: 'sql', command: sql, ...(params ? { params } : {}) };
    let lastErr: unknown;
    for (let attempt = 0; attempt <= QUERY_MAX_RETRIES; attempt++) {
      try {
        return await this.request(`/api/v1/query/${db}`, body);
      } catch (e) {
        lastErr = e;
        const retryable =
          (e instanceof ArcadeHttpError && RETRYABLE_STATUS.has(e.status)) ||
          !(e instanceof ArcadeHttpError); // network/timeout error
        if (!retryable || attempt === QUERY_MAX_RETRIES) throw e;
        // Full-jitter backoff, capped.
        const ceil = Math.min(QUERY_RETRY_CAP_MS, QUERY_RETRY_BASE_MS * 2 ** attempt);
        await sleep(Math.floor(Math.random() * ceil));
      }
    }
    throw lastErr;
  }

  /**
   * Mutation lane — POST /api/v1/command/{db}. NEVER retried: a command may not
   * be idempotent, and the transport can't know. Replay safety is the outbox's
   * job, not the socket's.
   */
  command(
    db: string,
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<ArcadeCommandResult> {
    return this.request(`/api/v1/command/${db}`, {
      language: 'sql',
      command: sql,
      ...(params ? { params } : {}),
    });
  }

  /**
   * Batched mutation lane — POST /api/v1/command/{db} with language:sqlscript,
   * running N statements in one round-trip (arcadeBulk.ts). Same no-retry
   * posture as command() (it's a mutation batch).
   */
  commandScript(
    db: string,
    script: string,
    params?: Record<string, unknown>,
  ): Promise<ArcadeCommandResult> {
    return this.request(`/api/v1/command/${db}`, {
      language: 'sqlscript',
      command: script,
      ...(params ? { params } : {}),
    });
  }

  /**
   * Server-level command lane — POST /api/v1/server (root only). Setup-time
   * db/user DDL. NEVER retried (user/db DDL is not idempotent — see
   * provisioner's drop-then-create note). NOT exposed to tenant adapters.
   */
  serverCommand(command: string): Promise<ArcadeCommandResult> {
    return this.request('/api/v1/server', { command });
  }
}

/**
 * retryIdempotentArcadeWrite — bounded retry, SAME policy as query()'s
 * (502/503/504, full-jitter backoff, capped), for a mutation the CALLER has
 * independently established is idempotent (e.g. a full-column
 * `UPDATE ... UPSERT WHERE id = :id`, safe to replay with the same params).
 *
 * command()/commandScript() themselves stay non-retrying on purpose (see the
 * class doc comment) — the transport can't know if an arbitrary command is
 * idempotent. This helper exists for the callers who DO know, so they aren't
 * stuck choosing between "never retry" and "retry blindly."
 *
 * Root cause this was written for (2026-08-21, ArcadeDB spike investigation):
 * a burst of ~120 sequential node upserts produced a real, live, reproducible
 * ArcadeDB HTTP 503 for a small subset (9/120 one run, 4/120 the next) — not
 * a Lore bug. The container's own logs show its vector index (LSMVectorIndex)
 * rebuilding its ENTIRE graph from scratch on every single insert
 * ("Building graph with N vectors" repeating once per write), which
 * saturates the server under a rapid sequential burst and yields transient
 * 503s until it catches up. Retrying the write (which is genuinely safe to
 * replay here) recovers from that without touching ArcadeDB's own indexing
 * behavior, which is out of Lore's control.
 */
export async function retryIdempotentArcadeWrite<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= QUERY_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof ArcadeHttpError && RETRYABLE_STATUS.has(e.status);
      if (!retryable || attempt === QUERY_MAX_RETRIES) throw e;
      const ceil = Math.min(QUERY_RETRY_CAP_MS, QUERY_RETRY_BASE_MS * 2 ** attempt);
      await sleep(Math.floor(Math.random() * ceil));
    }
  }
  throw lastErr;
}
