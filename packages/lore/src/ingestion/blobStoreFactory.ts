/**
 * ingestion/blobStoreFactory.ts - picks the source-file store from host config.
 *
 *   LORE_INGEST_BLOB_STORE=fs           (default) files under <workspace>/ingestion-blobs, as before
 *   LORE_INGEST_BLOB_STORE=groundfloor  Groundfloor workspace Files API (see groundfloorBlobStore.ts); login is a static
 *                                       bearer token OR a machine login (LORE_INGEST_GF_M2M_*, see groundfloorM2mToken.ts)
 *
 * Fail closed: an unrecognised store name or an incomplete groundfloor setting throws here, and the host then refuses to
 * open any workspace for ingestion. It never quietly falls back to the local disk, because the operator asked for the
 * files to live somewhere else.
 */
import * as path from 'node:path';
import { FsBlobStore, type IBlobStore } from './blobStore.js';
import { GroundfloorBlobStore } from './groundfloorBlobStore.js';
import type { IngestHostConfig } from './hostConfig.js';
import { M2mTokenProvider, m2mTokenUrlFor } from './groundfloorM2mToken.js';

export interface BlobStoreFactoryDeps { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number }

/** Returns a function that builds the blob store for one workspace directory. Throws on invalid configuration. */
export function makeBlobStoreFactory(cfg: IngestHostConfig['blobs'], deps: BlobStoreFactoryDeps = {}): (workspaceDir: string) => IBlobStore {
    if (cfg.store === 'invalid') throw new Error(`LORE_INGEST_BLOB_STORE has an unrecognised value (expected 'fs' or 'groundfloor')`);
    if (cfg.store === 'fs') return (dir) => new FsBlobStore(path.join(dir, 'ingestion-blobs'));
    const g = cfg.groundfloor;
    const m2m = g.m2m;
    const wantsM2m = m2m.clientId !== null || m2m.secretDeclared;
    // A static token and a machine login are two ways to answer the same question; both set is a mistake, not a preference.
    if (wantsM2m && g.tokenDeclared) {
        throw new Error('LORE_INGEST_GF_TOKEN / LORE_INGEST_GF_TOKEN_FILE and LORE_INGEST_GF_M2M_CLIENT_ID / LORE_INGEST_GF_M2M_CLIENT_SECRET are mutually exclusive: set one login method');
    }
    const token = g.token;
    const missing = [!g.baseUrl && 'LORE_INGEST_GF_API_URL', !g.workspaceId && 'LORE_INGEST_GF_WORKSPACE_ID'];
    if (wantsM2m) missing.push(!m2m.clientId && 'LORE_INGEST_GF_M2M_CLIENT_ID', (!m2m.clientSecret || m2m.clientSecret.reveal() === '') && 'LORE_INGEST_GF_M2M_CLIENT_SECRET (or _FILE, readable and not empty)');
    else missing.push(!token && 'LORE_INGEST_GF_TOKEN (or LORE_INGEST_GF_M2M_CLIENT_ID + LORE_INGEST_GF_M2M_CLIENT_SECRET)');
    const missingNames = missing.filter(Boolean).join(', ');
    if (missingNames) throw new Error(`LORE_INGEST_BLOB_STORE=groundfloor needs ${missingNames}`);
    const common = {
        baseUrl: g.baseUrl!, filesWorkspaceId: g.workspaceId!, timeoutMs: g.timeoutMs, maxRetries: g.maxRetries, maxBytes: g.maxBytes,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}),
    };
    // One stateless client serves every workspace; the Lore workspace is part of each object name, not of the connection.
    let store: GroundfloorBlobStore;
    if (wantsM2m) {
        const secret = m2m.clientSecret!;
        const provider = new M2mTokenProvider({
            tokenUrl: m2mTokenUrlFor(g.baseUrl!, g.workspaceId!), clientId: m2m.clientId!, clientSecret: () => secret.reveal(), timeoutMs: g.timeoutMs,
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.now ? { now: deps.now } : {}),
        });
        store = new GroundfloorBlobStore({ ...common, token: () => provider.get(), onUnauthorized: (rejected) => provider.refresh(rejected) });
    } else {
        store = new GroundfloorBlobStore({ ...common, token: () => token!.reveal() });
    }
    return () => store;
}
