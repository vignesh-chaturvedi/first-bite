import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Phase 1 stores application health only. Campaign data arrives in Phase 3.
export const appMetadata = pgTable('app_metadata', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
});

export const serviceHeartbeats = pgTable('service_heartbeats', {
  workerId: text('worker_id').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
});
