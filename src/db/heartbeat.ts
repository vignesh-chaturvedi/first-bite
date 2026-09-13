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
