# Lore cache-key contract (v1)

Status: locked 2026-04-24.
Owners: core (engines/cache.ts).
Consumers: Q1.3 local in-proc LRU (shipped), Q2.3 Redis tier (planned).

This document specifies the **cache-key contract** shared by every Lore
cache substrate. The point of writing it down: Q2.3 swaps the substrate
(LRU → Redis) without changing the key shape or the invalidation
semantics. Caller code doesn't learn anything new when the substrate
flips.

## Key format

```
v1|<kind>|<workspace>|<epoch>|<params-sha1>
```

| segment       | meaning                                                                                   |
|---------------|-------------------------------------------------------------------------------------------|
| `v1`          | Contract version. Bumping this resets every cache — use only for breaking changes.        |
| `<kind>`      | Read-op label. Today: `search`, `listNodes`, `getNode`, `traverse`. Extensible.           |
| `<workspace>` | Active workspace id. Scopes every entry — cross-workspace reads never collide.            |
| `<epoch>`     | Monotonic counter owned by the substrate. Bumped on every write. See Invalidation below.  |
| `<params-sha1>` | First 16 hex chars of `sha1(stableStringify(params))`. Stable key ordering guaranteed.  |

Reference implementation: `packages/lore/src/engines/cache.ts` →
`cacheKey(kind, workspace, epoch, params)`.

### Example

A `search("authorization retry", limit=20, project='*', ecosystem='*')`
call against the `default` workspace at epoch 7 produces:

```
v1|search|default|7|2f8a14c06b1e9d47
```

After the next write (`store_node`, `store_edge`, reconnect, delete)
the substrate bumps its epoch to 8. The identical search now keys on
`v1|search|default|8|2f8a14c06b1e9d47` — a cache miss by construction,
so the read re-runs against the source of truth.

## Invalidation: coarse epoch bump

Rule: every mutation path calls `bumpEpoch()` on the substrate before
or after (inclusive) the write lands. The epoch is part of every
subsequent cache key, so:

- **Reads that happened before the write** stay addressable in the
  substrate by their old key, but are no longer reachable by any new
  caller (new caller reads the fresh epoch).
- **Reads issued after the write** hash to the new epoch, miss, and
  repopulate from source.

Trade-off accepted: every write invalidates the whole cache logically,
including entries the write did not semantically touch. Chosen because
(a) it's O(1); (b) the substrate knows nothing about the semantics of
the values it holds (a `search()` result could contain any node whose
tags matched — fine-grained invalidation would require content-indexing
every cached key); (c) LRU absorbs memory pressure for unreachable
entries.

For the local (in-proc) substrate, unreachable entries age out via LRU
eviction on pressure — `bumpEpoch()` does not scan or clear the map.
For the Q2.3 Redis substrate the same discipline holds: bump the shared
counter; do not touch the key space.

## Write-through hooks (local substrate, current)

Hooks that must call `bumpEpoch()`:

| hook                            | path                                    |
|---------------------------------|-----------------------------------------|
| `upsertNode` (insert + update)  | `LocalGraph.upsertNode`                 |
| `addEdge`                       | `LocalGraph.addEdge`                    |
| `deleteNode`                    | `LocalGraph.deleteNode`                 |
| `pruneInferredLoreEdges`        | `LocalGraph.pruneInferredLoreEdges`     |
| reconnect mutation              | transitively, via `addEdge` + `prune…`  |

The reconnect engine (`engines/reconnect.ts`) does not bump directly —
it only calls the hooks above. This is deliberate: one source of truth
for the invariant "every mutation bumps the epoch exactly once."

## Workspace isolation

Workspace id is part of every key. Switching workspaces can never
return a cross-workspace hit — even if `kind` and `params` happen to
collide. This is enforced structurally, not by convention, so a future
multi-workspace-per-process runtime inherits the isolation for free.

## Q2.3 Redis substrate (planned)

The Redis tier implements the same contract:

- **Key format**: identical. Prefix Redis keys with `lore:` for
  operational hygiene, but the trailing shape is unchanged
  (`lore:v1|search|workspace-a|epoch|hash`).
- **Epoch storage**: a Redis counter per workspace
  (`lore:epoch:<workspace>`). `INCR` on write (atomic).
- **Invalidation fanout**: via Dataplane v3 change-feed subscription.
  Any node of any replica hears the bump and refreshes its view of
  the epoch before the next read.
- **TTL**: per-entry TTL matches the LRU substrate's TTL, set as a
  Redis `EXPIRE` on write. Redis eviction policy (`allkeys-lru`)
  retires unreachable entries automatically.
- **Pre-warm**: Q2.3 reserves a per-workspace pre-warm pass that
  issues top-N FAQ-shaped reads into the cache after a flush. Keys
  are identical to the reactive path — pre-warm just lands the same
  keys before the first user asks.

Caller code is unchanged: it keeps calling `readCache.memoize(key,
loader)` with the result of `cacheKey(...)`. The substrate difference
is invisible above the adapter line.

## Versioning

- `v1` is the current contract. It ships with Q1.3 (local) and Q2.3
  (Redis) unchanged.
- Breaking changes (key-shape or epoch-semantics) bump to `v2` and
  include a cut-over policy (`v1` entries ignored by readers; writers
  set `v2` exclusively; pre-v2 entries age out of LRU in one TTL and
  out of Redis on the next flush).
- Non-breaking additions (new `kind` label, new params field) do not
  bump the version — they extend the `<kind>` enumeration and rely on
  `params-sha1` to isolate the new shape from old entries.

## Non-goals

- **Content-addressed invalidation.** Explicitly rejected. See
  "coarse epoch bump" above.
- **Cross-substrate promotion** (local → Redis for hot entries). A
  Redis tier in server mode doesn't want LRU noise; a local tier in
  laptop mode doesn't want Redis latency. The contract enables swap,
  not tiering.
- **Per-user keys.** Today: workspace-scoped only. Per-user caching
  is a Q2.5 concern (principal-list filtering) and will key off the
  principal string as an additional segment at that time.

## Test coverage

- Unit: `packages/lore/src/engines/cache.test.ts` — stable-stringify,
  epoch discipline, TTL, LRU eviction.
- Integration: write-then-read against `LocalGraph` (see
  `scripts/bench-cache.mjs` phase 3).
- SLO: `scripts/bench-cache.mjs` gates on ≥3× p95 speedup,
  hot-p95 ≤200ms, invalidation PASS.
