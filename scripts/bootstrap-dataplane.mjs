#!/usr/bin/env node
/**
 * bootstrap-dataplane.mjs — One-shot Dataplane bootstrap for Lore.
 *
 * Run once per dev laptop (or once per cloud deploy) BEFORE booting Lore
 * in --mode=cloud. Idempotent — re-runs are safe.
 *
 * What it does:
 *   1. Asserts required env vars and prints a checklist.
 *   2. Registers the Lore tenant with Dataplane via admin token
 *      (HTTP POST /admin/tenants — the SDK doesn't expose registerTenant
 *      yet; using direct HTTP for portability).
 *   3. Triggers Lore's lazy createCollection path so lore_node / lore_edge
 *      / lore_verbatim exist in Dataplane.
 *   4. Seeds a portal_workspace for the operator and grants them `owner`
 *      so ReBAC checks pass on first request.
 *
 * What it deliberately does NOT do:
 *   - Push a SpiceDB schema (we reuse the existing portal_* schema as-is).
 *   - Mint per-user JWTs (Clerk is the IdP at request time).
 *   - Run any Dataplane / SpiceDB containers (assumed already running).
 *
 * Required env vars:
 *   DATAPLANE_URL              http://localhost:8080
 *   DATAPLANE_ADMIN_TOKEN      privileged key matching Dataplane's ADMIN_TOKEN
 *   DATAPLANE_API_KEY          tenant-scoped key (minted by Dataplane after
 *                              tenant registration; can be set after step 2)
 *   TENANT_ID                  e.g. 'lore'
 *
 * Optional (for the operator-seed step):
 *   LORE_BOOTSTRAP_USER_ID         portal_user id to grant ownership to
 *   LORE_BOOTSTRAP_WORKSPACE_ID    portal_workspace id to seed (default 'lore-default')
 *
 * Usage:
 *   node scripts/bootstrap-dataplane.mjs [--skip-tenant-register]
 *                                        [--skip-collections]
 *                                        [--skip-seed]
 */

import { GroundfloorClient } from 'groundfloor-ts-sdk';

const args = new Set(process.argv.slice(2));
const skipTenantRegister = args.has('--skip-tenant-register');
const skipCollections = args.has('--skip-collections');
const skipSeed = args.has('--skip-seed');

const DATAPLANE_URL = process.env.DATAPLANE_URL ?? 'http://localhost:8080';
const ADMIN_TOKEN = process.env.DATAPLANE_ADMIN_TOKEN;
const API_KEY = process.env.DATAPLANE_API_KEY;
const TENANT_ID = process.env.TENANT_ID ?? 'lore';
const USER_ID = process.env.LORE_BOOTSTRAP_USER_ID;
const WORKSPACE_ID = process.env.LORE_BOOTSTRAP_WORKSPACE_ID ?? 'lore-default';

function fail(msg) {
    console.error(`\n✗ ${msg}\n`);
    process.exit(1);
}

function ok(msg) {
    console.log(`✓ ${msg}`);
}

function info(msg) {
    console.log(`  ${msg}`);
}

async function registerTenant() {
    if (skipTenantRegister) { info('skipping tenant registration (--skip-tenant-register)'); return; }
    if (!ADMIN_TOKEN) fail('DATAPLANE_ADMIN_TOKEN is required for tenant registration. Generate with: openssl rand -hex 32 — must match Dataplane container ADMIN_TOKEN.');
    const url = `${DATAPLANE_URL}/admin/tenants`;
    const body = JSON.stringify({ tenantId: TENANT_ID, displayName: 'Lore Service' });
    let resp;
    try {
        resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${ADMIN_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body,
        });
    } catch (e) {
        fail(`Could not reach Dataplane at ${url}. Is the container up? Original error: ${e.message}`);
    }
    if (resp.status === 200 || resp.status === 201) {
        ok(`tenant '${TENANT_ID}' registered`);
        return;
    }
    if (resp.status === 409) {
        ok(`tenant '${TENANT_ID}' already registered (409 — idempotent skip)`);
        return;
    }
    if (resp.status === 404) {
        info(`POST /admin/tenants returned 404 — this Dataplane build may use a different admin path.`);
        info(`Skipping with a warning. Verify tenant exists out-of-band; if not, register manually.`);
        return;
    }
    const text = await resp.text().catch(() => '');
    fail(`tenant registration failed [${resp.status}]: ${text.slice(0, 200)}`);
}

async function pushCollections(client) {
    if (skipCollections) { info('skipping collection push (--skip-collections)'); return; }

    // Lore's three core collections. Schema fields are documented in
    // dataplaneGraph.ts / dataplaneVectorStore.ts; we keep the bootstrap
    // permissive (additive fields can be added later via the engine's
    // own ensureTenantInitialized path on first cloud-mode write).
    const collections = [
        { name: 'lore_node',     description: 'LoreNode rows' },
        { name: 'lore_edge',     description: 'LoreEdge rows' },
        { name: 'lore_verbatim', description: 'Verbatim documents + embeddings' },
    ];

    for (const c of collections) {
        try {
            // The SDK's createCollection signature is (schema, connection?).
            // The engine accepts a permissive schema; concrete columns are
            // managed by Lore's ensureTenantInitialized when the daemon
            // writes its first row. We only need to declare the collection
            // exists so subsequent SDK calls don't 404.
            await client.createCollection({ name: c.name, fields: [] });
            ok(`collection '${c.name}' created`);
        } catch (e) {
            const msg = e?.message ?? String(e);
            if (/already exists|409/i.test(msg)) {
                ok(`collection '${c.name}' already exists (idempotent skip)`);
            } else {
                info(`createCollection('${c.name}') failed: ${msg}`);
                info(`  This may be fine if Lore's lazy ensureTenantInitialized handles it on first write.`);
            }
        }
    }
}

async function seedOperator(client) {
    if (skipSeed) { info('skipping operator seed (--skip-seed)'); return; }
    if (!USER_ID) {
        info('skipping operator seed: LORE_BOOTSTRAP_USER_ID not set. Set it to the operator\'s portal_user id and re-run with --skip-tenant-register --skip-collections to grant relations only.');
        return;
    }
    try {
        await client.grantRelation({
            subjectType: 'portal_user', subjectId: USER_ID,
            relation: 'owner',
            resourceType: 'portal_workspace', resourceId: WORKSPACE_ID,
        });
        ok(`granted '${USER_ID}' owner of portal_workspace '${WORKSPACE_ID}'`);
    } catch (e) {
        const msg = e?.message ?? String(e);
        if (/already exists|409/i.test(msg)) {
            ok(`relation already exists (idempotent skip)`);
        } else {
            fail(`grantRelation failed: ${msg}`);
        }
    }
}

async function main() {
    console.log(`\n→ Lore Dataplane bootstrap`);
    console.log(`  DATAPLANE_URL = ${DATAPLANE_URL}`);
    console.log(`  TENANT_ID     = ${TENANT_ID}`);
    console.log('');

    await registerTenant();

    if (!API_KEY) {
        info('DATAPLANE_API_KEY not set — skipping collection push + operator seed.');
        info('After Dataplane mints a tenant-scoped key, set DATAPLANE_API_KEY and re-run with --skip-tenant-register.');
        console.log('\nDone (partial — set DATAPLANE_API_KEY and re-run for collections + seed).\n');
        return;
    }

    const client = new GroundfloorClient(DATAPLANE_URL, API_KEY);
    await pushCollections(client);
    await seedOperator(client);

    console.log('\nDone. Next:');
    console.log('  1. Boot Lore: lore --mode=cloud serve --http');
    console.log('  2. Verify: lore doctor (should report dataplane reachable + workspace owner relation)');
    console.log('');
}

main().catch((e) => {
    console.error(`\n✗ Bootstrap failed:`, e);
    process.exit(1);
});
