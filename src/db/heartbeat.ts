import type { Database } from './client';
import { serviceHeartbeats } from './schema';

export async function upsertHeartbeat(
  db: Database,
  input: { workerId: string; startedAt: Date; seenAt?: Date },
): Promise<void> {
  if (!input.workerId || input.workerId.length > 128) {
    throw new Error('Worker identifier must contain 1–128 characters');
  }
  const seenAt = input.seenAt ?? new Date();
  if (!Number.isFinite(input.startedAt.getTime()) || !Number.isFinite(seenAt.getTime())) {
    throw new Error('Worker timestamps must be valid dates');
  }
  await db.insert(serviceHeartbeats).values({
    workerId: input.workerId,
    startedAt: input.startedAt,
    lastSeenAt: seenAt,
  }).onConflictDoUpdate({
    target: serviceHeartbeats.workerId,
    set: { startedAt: input.startedAt, lastSeenAt: seenAt },
  });
}

/** Only an execution tick may publish this role; the shell worker uses bare UUIDs. */
export async function upsertExecutionHeartbeat(db: Database, input: { workerId: string; startedAt: Date; seenAt?: Date }): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.workerId)) throw new Error('Invalid execution worker identifier');
  await upsertHeartbeat(db, { ...input, workerId: `execution:${input.workerId}` });
}
