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
import { RevisionConflictError, revisionOf } from '../graphShared/revision.js';
import { OutcomeUnknownError, rereadAfterWriteError } from '../graphShared/writeOutcome.js';

export async function settleFailedUpsert(
  read: () => Promise<LoreNode | null>,
  id: string,
  err: unknown,
  ctx: { existed: boolean; expectedRevision: number; updatedAt: string },
): Promise<LoreNode> {
  const { existed, expectedRevision, updatedAt } = ctx;
  const present = await rereadAfterWriteError(read, id, err);
  const actualNow = revisionOf(present);
  if (present && present.updatedAt === updatedAt && actualNow === expectedRevision + 1) return present; // our own write, response lost
  const duplicate = err instanceof ArcadeHttpError && /duplicat/i.test(err.body);
  if (existed ? !present || actualNow !== expectedRevision : present || duplicate) {
    throw new RevisionConflictError(id, expectedRevision, actualNow);
  }
  if (err instanceof ArcadeHttpError) throw err; // the server refused and nothing was applied
  throw new OutcomeUnknownError(id, present ? actualNow : null, err);
}
