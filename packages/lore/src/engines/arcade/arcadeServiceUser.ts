/**
 * arcadeServiceUser.ts — ArcadeDB server-level service-user lifecycle
 * (create / rotate / drop) for the db-per-app provisioner. Split out of
 * arcadeProvisioner.ts for the file-size budget (slice 5). The 26.7.1
 * platform-constraint doc block is preserved verbatim.
 * (branch: spike/arcadedb-multitenant, slice 5 GA hardening)
 *
 * These are the ONLY production callers of ArcadeDB server commands touching
 * users; they go through arcadeRootTransport (TLS-hardened root ArcadeHttp).
 */

import { ArcadeHttpError } from './arcadeHttp.js';
import { spikeArcadeServerCommand } from './arcadeRootTransport.js';

export async function userExists(userName: string): Promise<boolean> {
  try {
    const res = await spikeArcadeServerCommand('list users');
    const rows = (res.result ?? []) as Array<Record<string, unknown>>;
    return rows.some((r) => {
      const name = (r['name'] ?? r['user'] ?? r['userName']) as string | undefined;
      return name === userName;
    });
  } catch {
    // `list users` shape isn't guaranteed across builds — fall back to a
    // create-and-catch-already-exists probe at the call site instead of
    // failing provisioning outright.
    return false;
  }
}

/**
 * Create the per-DB service-account user granted admin on EXACTLY ONE
 * database (the proven 403 wall).
 *
 * PLATFORM CONSTRAINT (discovered live against 26.7.1, corrects the plan's
 * original "never drop-then-create" wording): decompiling
 * `PostServerCommandHandler` in the running container's server jar
 * (arcadedb-server-26.7.1.jar) confirms the ONLY two user verbs the server
 * command lane implements are `create user` and `drop user` — there is no
 * `alter user` / `update user` verb at all ("Server command not valid" is
 * what the server returns for both, confirmed empirically). `create user`
 * on an existing name throws `SecurityException: User '<name>' already
 * exists` (HTTP 403) rather than upserting. So an in-place password
 * rotation is NOT possible on this version — the only way to change an
 * existing user's password or grants through the server-command API is
 * drop-then-create.
 *
 * INVARIANT ENFORCED HERE (availability fix): the drop+create branch runs
 * ONLY when the caller genuinely rotates to a DIFFERENT password
 * (`rotateIfExists: true`). When the caller's REGISTRY already knows this
 * cell's user exists AND the on-file password was reused (`assumeExists: true`,
 * no rotate — provisionApp's idempotent re-run), this issues NO server command
 * at all: a TRUE NO-OP on the live ArcadeDB user. Concretely:
 *   - registry says exists + reused pw, no rotate → NO-OP (routine re-provision)
 *   - user ABSENT                                 → create (first provision)
 *   - rotate (different pw)                        → drop+create (only 26.7.1 verb)
 * The registry row is the authoritative existence signal because `list users`
 * is NOT a verb on 26.7.1 (userExists() fails closed to false there).
 * TODO(arcade-phase-7): revisit if a future ArcadeDB release adds a real
 * update-user verb.
 */
export async function createOrRotateServiceUser(
  userName: string,
  password: string,
  dbName: string,
  opts?: {
    /** True ONLY when the caller is genuinely rotating to a DIFFERENT password
     *  (rotateCredential / disableApp) — runs the drop+create repair path. */
    rotateIfExists?: boolean;
    /** Registry-sourced hint that the user is ALREADY provisioned (row exists
     *  AND on-file password reused). Authoritative existence signal; when set
     *  and not a rotation, this is a TRUE no-op (NO server command at all). */
    assumeExists?: boolean;
  },
): Promise<void> {
  const payload = JSON.stringify({
    name: userName,
    password,
    databases: { [dbName]: ['admin'] },
  });
  const rotateIfExists = opts?.rotateIfExists ?? false;
  const assumeExists = opts?.assumeExists ?? false;

  // TRUE no-op path: registry knows the user exists and the caller reused the
  // on-file password (not a rotation). Issue NOTHING.
  if (assumeExists && !rotateIfExists) return;

  // Otherwise, if we can positively confirm the user exists (builds exposing
  // `list users`), take the decision directly rather than via create-and-catch.
  if (await userExists(userName)) {
    if (!rotateIfExists) return;
    await spikeArcadeServerCommand(`drop user ${userName}`);
    await spikeArcadeServerCommand(`create user ${payload}`);
    return;
  }

  // User is absent (first-time provisioning — the common path) OR list-users
  // couldn't be trusted (failed closed to false). Try create; fall back to the
  // create-and-catch-already-exists probe.
  try {
    await spikeArcadeServerCommand(`create user ${payload}`);
    return;
  } catch (e) {
    const alreadyExists = e instanceof ArcadeHttpError && /already exists/i.test(e.body);
    if (!alreadyExists) throw e;
  }
  // The user existed after all (userExists() under-reported). Non-rotation is a
  // no-op; only a genuine rotation drops+recreates.
  if (!rotateIfExists) return;
  await spikeArcadeServerCommand(`drop user ${userName}`);
  await spikeArcadeServerCommand(`create user ${payload}`);
}

/**
 * dropServiceUser — slice-5 destroyApp cleanup: remove the server-level ArcadeDB
 * user so it does not orphan forever. Idempotent twin of `create user`: a
 * "not found"/"does not exist" response is swallowed (the user was already gone,
 * e.g. a destroy re-run or a build that never created it). Any OTHER error
 * propagates.
 *
 * WHY: destroyApp previously dropped the database + registry row but NEVER the
 * server-level user (`<t>_<a>_svc`), permanently orphaning it. Orphans
 * accumulate forever, and a future re-provision of the same cell name hits the
 * already-exists repair path against a user whose password nobody knows. This
 * closes that leak.
 */
export async function dropServiceUser(userName: string): Promise<void> {
  try {
    await spikeArcadeServerCommand(`drop user ${userName}`);
  } catch (e) {
    if (!(e instanceof ArcadeHttpError)) throw e;
    // Swallow "user not found / does not exist"; anything else is real.
    if (!/not exist|not found|no such user|unknown user/i.test(e.body)) throw e;
  }
}
