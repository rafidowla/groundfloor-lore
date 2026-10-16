/**
 * arcadeWriteSettle — decide what a FAILED conditional node write means (3.34.0, M2).
 *
 * A command that fails may still have committed: a client-side timeout or socket error is a plain
 * Error (not an ArcadeHttpError) and tells us nothing about the server. So after ANY failure we
 * re-read, and either recognise our own write, report the rival that beat us, or — when nothing
 * can be proven — answer OutcomeUnknownError (never a plain failure, never a compensating row).
 */
import type { LoreNode } from '../../providers/types.js';
import { ArcadeHttpError } from './arcadeHttp.js';
import { isArcadeConcurrentModification, isArcadeConnectRefused } from './arcadeTransientErrors.js';
import { NodeAlreadyExistsError } from '../graphShared/conditionalInsert.js';
import { RevisionConflictError, revisionOf } from '../graphShared/revision.js';
import { OutcomeUnknownError, rereadAfterWriteError } from '../graphShared/writeOutcome.js';

/**
 * The server answered with a refusal that proves the write did not land: a duplicate-key rejection or a
 * concurrent-modification abort (the transaction rolled back). Such a failure must never be "recognised" as our own
 * write by comparing the stored row's stamp with ours - two writers can share a millisecond stamp.
 */
export const isDefiniteNoWrite = (err: unknown): boolean =>
  err instanceof ArcadeHttpError && (/duplicat/i.test(err.body) || isArcadeConcurrentModification(err));

export async function settleFailedUpsert(
  read: () => Promise<LoreNode | null>,
  id: string,
  err: unknown,
  ctx: { existed: boolean; expectedRevision: number; updatedAt: string },
): Promise<LoreNode> {
  const { existed, expectedRevision, updatedAt } = ctx;
  // A refused connection provably wrote nothing, and the server being down would fail the re-read too (which would
  // wrongly read as outcome_unknown): hand it to retryIdempotentArcadeWrite for a fresh, re-judged attempt.
  if (isArcadeConnectRefused(err)) throw err;
  const present = await rereadAfterWriteError(read, id, err);
  const actualNow = revisionOf(present);
  const duplicate = err instanceof ArcadeHttpError && /duplicat/i.test(err.body);
  if (!isDefiniteNoWrite(err) && present && present.updatedAt === updatedAt && actualNow === expectedRevision + 1) return present; // our own write, response lost
  if (existed ? !present || actualNow !== expectedRevision : present || duplicate) {
    throw new RevisionConflictError(id, expectedRevision, actualNow);
  }
  if (err instanceof ArcadeHttpError) throw err; // the server refused and nothing was applied
  throw new OutcomeUnknownError(id, present ? actualNow : null, err);
}

/**
 * Decide what a FAILED `insertNodeIfAbsent` INSERT means (stamped `now`). Returns the node only when it is provably ours.
 *
 *   - duplicate key: the id is taken (NodeAlreadyExistsError);
 *   - CME abort: nothing was written, so a row now present is another writer's (NodeAlreadyExistsError), and a still
 *     free id rethrows the error for `retryIdempotentArcadeWrite`'s fresh attempt;
 *   - a refused connection: nothing was sent, rethrown for the retry (a fresh attempt, fresh stamp);
 *   - anything else (a timeout, a socket error) is re-read: a row stamped `now` is our own insert whose response was
 *     lost; any other row means the id was taken; a failed re-read is an unknown outcome.
 */
export async function settleFailedInsert(read: () => Promise<LoreNode | null>, id: string, err: unknown, now: string): Promise<LoreNode> {
  if (isArcadeConnectRefused(err)) throw err; // nothing was sent; see settleFailedUpsert
  if (isDefiniteNoWrite(err)) {
    if (/duplicat/i.test((err as ArcadeHttpError).body)) throw new NodeAlreadyExistsError(id);
    let taken: LoreNode | null = null;
    try { taken = await read(); } catch { /* the retry settles it */ }
    if (taken) throw new NodeAlreadyExistsError(id);
    throw err;
  }
  const present = await rereadAfterWriteError(read, id, err);
  if (present && present.createdAt === now) return present; // our own insert, response lost
  if (present) throw new NodeAlreadyExistsError(id);
  if (!(err instanceof ArcadeHttpError)) throw new OutcomeUnknownError(id, null, err);
  throw err;
}
