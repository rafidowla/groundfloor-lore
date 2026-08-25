# Lore SpiceDB Schemas

## Files

| File | Status | Owner |
|---|---|---|
| [`portal-mimic.zed`](portal-mimic.zed) | Reference contract — what the `lore__*` types in the deployed gf_authz YAML compile to | Lore team |

## How Lore's auth types reach SpiceDB

Per the Groundfloor SpiceDB strategy
([`SPICEDB_STRATEGY.md`](https://github.com/groundfloor-dataplane-oss/blob/main/docs/SPICEDB_STRATEGY.md)),
each customer app gets a prefixed namespace. Lore's app id is `lore`, so
our SpiceDB types are **`lore__user`**, **`lore__account`**,
**`lore__workspace`**, **`lore__environment`**.

`portal-mimic.zed` is the **reference shape** — same relations + same
permission expressions that we deploy via gf_authz YAML for `(tenant,
app=lore)`. The dataplane's authz compiler reads that YAML, prefixes
every type with `lore__`, and merges into SpiceDB. The result is that
SpiceDB sees `lore__workspace { … }`, not `portal_workspace { … }`.

**Lore does NOT:**
- Push `portal_*` types — those belong to ControlPlane (own prefix, own owner).
- Use `/v1/admin/rebac/schema` — that's the platform's path (gf_* types).
- Write tuples for `portal_*` types — only ControlPlane does that.

**Lore DOES:**
- Deploy via `POST /v1/authz/schema?app=lore` (additive merge; only `lore__*` types affected).
- Write tuples for `lore__*` types via the SDK (`grantRelation`, `transaction.rebac_write`).
- Check permissions against `lore__*` types via `dataplane.checkPermission(...)` (compile-time enforced by `LoreResourceType` in `rebacGate.ts`).

**Cross-app references** (e.g. a `lore__workspace` whose `account`
relation points at a `portal_account`) are supported by SpiceDB and
fine in principle, but every such reference creates a deploy-order
dependency on ControlPlane having that prefix live.

## Vocabulary contract

The closed permission set Lore enforces in `rebacGate.ts`:

```
administer | read | write | delete | ddl | deploy |
manage_members | view_billing
```

Object types (Lore's prefix only): `lore__user`, `lore__account`,
`lore__workspace`, `lore__environment`. Lore's row-level
`security_scopes` filter (`security/scopeFilter.ts`) layers on top of
this for fine-grain control inside a workspace SpiceDB has already
allowed.

## When the canonical ControlPlane schema lands

When `groundfloor-client-portal/spicedb/schema.zed` ships its
canonical `portal_*` schema, **nothing in this directory needs to
change** — Lore's types are `lore__*`, not `portal_*`. We only react
if a cross-app reference of ours (e.g. `lore__workspace.account ->
portal_account`) becomes meaningful, in which case ControlPlane's
deploy needs to land before our YAML referencing it does.
