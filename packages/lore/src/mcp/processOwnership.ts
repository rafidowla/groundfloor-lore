/**
 * processOwnership.ts — the process-GLOBAL side effects, gated on ownership.
 *
 * Lore is a LIBRARY as well as a daemon. `createLore()` is the public embedded
 * entrypoint, so anything it does to shared process state is done to whatever
 * application happens to be hosting it. Two boot steps mutate state Lore does
 * not own:
 *
 *   - `runEnvScrub()` deletes every non-allowlisted variable from
 *     `process.env` (S9).
 *   - `armNativePoolSafetyNet()` installs process-global
 *     `uncaughtException` / `unhandledRejection` handlers with a SURVIVE
 *     policy (TW-2b / NW-1c).
 *
 * Both are correct for the daemon, where Lore owns the process: it inherits an
 * IDE's full environment (AWS/GitHub/etc. tokens it has no use for) and it is
 * the only thing running, so suppressing a native fault keeps the service up.
 * Both are wrong for a library consumer.
 *
 * S9-EMBEDDED-ENV-SCRUB — the defect this module exists to prevent. The scrub
 * sat unconditionally at the top of `createLore()`, so an embedding host had
 * its OWN environment deleted mid-process. Reported by an embedder that lost
 * `OPENROUTER_API_KEY`: every LLM call after Lore init failed with an upstream
 * "401 Missing Authentication header" while the key sat present and valid in
 * the host's `.env.local`, so the symptom pointed at the key rather than at
 * Lore. It reproduced in ALL THREE deployment modes and fired even when Lore's
 * own init threw — a non-functioning Lore still destroyed the host's config.
 *
 * OWNERSHIP IS THE PREDICATE, NOT MODE. `deploymentMode` selects substrates and
 * transport; it says nothing about whose process this is. A host can embed Lore
 * in-process with mode 'local' or 'cloud' just as legitimately as 'embedded'.
 * Gating on `mode !== 'embedded'` (what TW-2b originally did for the safety
 * net) therefore leaves the same defect reachable through a different door —
 * confirmed live: an in-process host with mode 'local' armed SURVIVE-policy
 * crash handlers in the host's process. Only the daemon entry `main()`, which
 * runs behind `isProcessEntrypoint()`, may claim ownership.
 *
 * Regression coverage: `test/sp17-env-scrub-timing-unit.ts` (part A, behavioral,
 * all three modes) and `test/tw2b-embedded-no-global-handlers-unit.ts` (case c).
 */

import { armNativePoolSafetyNet } from '../engines/nativePoolSafetyNet.js';
import { runEnvScrub } from './bootSteps.js';
import type { LoreDeploymentMode } from './server.js';

/**
 * S9 parent-env scrub — ONLY for a process Lore owns.
 *
 * ORDERING (SP-17): the caller must invoke this as the FIRST executed statement
 * of `createLore()`, ahead of every construction-path env read
 * (resolveWorkspaceScope / resolveDeploymentMode / createGraph /
 * createVectorStore / createEmbeddingProvider / resolveSyncAdapterFromEnv).
 * Anything read before the scrub sees the unscrubbed inherited environment —
 * the original SP-17 defect.
 *
 * That ordering constraint is why the gate takes the caller-supplied
 * `ownsProcess` flag and nothing else: the decision must be made WITHOUT
 * reading `process.env` or resolving the deployment mode, since either would
 * put an env read before the scrub and silently reintroduce SP-17.
 *
 * @param ownsProcess `true` only from the daemon entry. `undefined`/`false`
 *   (every library consumer) is a no-op — the host's environment is untouched.
 */
export function scrubEnvIfOwned(ownsProcess: boolean | undefined): void {
    if (ownsProcess !== true) return;
    runEnvScrub();
}

/**
 * TW-2b native-pool safety net — ONLY for a process Lore owns, and only when
 * that process is actually running a daemon-shaped instance.
 *
 * MUST be called BEFORE the native pools are constructed (createGraph + the
 * LanceDB pool during verbatim init): their constructors call
 * `installNativePoolSafetyNet()`, which no-ops unless the net has been armed.
 *
 * Both conditions are required. `ownsProcess` is the load-bearing one (see the
 * module header); the `mode !== 'embedded'` half is retained so daemon
 * behaviour is byte-for-byte what it was — `main()` boots local/cloud/arcade
 * and still arms exactly as before.
 *
 * @param ownsProcess `true` only from the daemon entry.
 * @param mode the resolved deployment mode.
 */
export function armNativePoolSafetyNetIfOwned(
    ownsProcess: boolean | undefined,
    mode: LoreDeploymentMode,
): void {
    if (ownsProcess !== true) return;
    if (mode === 'embedded') return;
    armNativePoolSafetyNet();
}

/**
 * May this instance start the daemon background sweepers (retention
 * auto-sweep, auth-registry sweep, consistency reconciliation, scheduled
 * compaction)?
 *
 * Same ownership predicate as the two above, and it is here for the same
 * reason. The original gate asked only `mode !== 'embedded'`, so a host that
 * embedded Lore in-process with mode 'local' started Lore's recurring
 * housekeeping loops inside the HOST — and because that instance takes the
 * plain (non-embedded) shutdown drain, several of those timers were never
 * cleared and kept firing after the host called dispose().
 *
 * Gating on ownership also matches the decided deployment model: in embedded
 * and other host-owned setups the HOST owns maintenance and drives sweeps on
 * its own schedule (docs/DEPLOYMENT_MODEL.md). Only a daemon that owns its
 * process runs them unprompted.
 *
 * Daemon path is unchanged: main() passes ownsProcess:true and boots
 * local/cloud/arcade, so every sweeper starts exactly as before.
 */
export function daemonTimersEnabled(
    ownsProcess: boolean | undefined,
    mode: LoreDeploymentMode,
): boolean {
    return ownsProcess === true && mode !== 'embedded';
}
