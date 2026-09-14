import { sql } from 'drizzle-orm';
import {
  bigint, check, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey,
  text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { SponsoredQuote } from '../lib/transactions/quote';

export const appMetadata = pgTable('app_metadata', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
});

export const serviceHeartbeats = pgTable('service_heartbeats', {
  workerId: text('worker_id').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
});

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'ended';
export type InviteStatus = 'active' | 'revoked' | 'consumed';
export type QuoteStatus = 'quoted' | 'reserved' | 'expired';
export type AttemptStatus = 'prepared' | 'signing' | 'signed' | 'submitted' | 'broadcast_unknown'
  | 'confirmed' | 'finalized' | 'manual_review' | 'complete' | 'failed' | 'expired';
export type LedgerEntryType = 'reserve' | 'release' | 'debit' | 'fee' | 'recovery';

// PostgreSQL numeric maps to decimal strings; never coerce native units to Number.
const native = (name: string) => numeric(name, { precision: 24, scale: 0 });
const time = (name: string) => timestamp(name, { withTimezone: true });
const created = () => time('created_at').defaultNow().notNull();

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').$type<CampaignStatus>().notNull(),
  startsAt: time('starts_at').notNull(),
  endsAt: time('ends_at').notNull(),
  maxUsers: integer('max_users').notNull(),
  capNative: native('cap_native').notNull(),
  reservedNative: native('reserved_native').default('0').notNull(),
  spentNative: native('spent_native').default('0').notNull(),
  reservedUsers: integer('reserved_users').default(0).notNull(),
  consumedUsers: integer('consumed_users').default(0).notNull(),
  sponsorPublicKey: text('sponsor_public_key').notNull(),
  policyVersion: text('policy_version').notNull(),
  maxRegistrationPriceNative: native('max_registration_price_native').notNull(),
  maxTransactionFeeNative: native('max_transaction_fee_native').notNull(),
  recoveryAllowanceNative: native('recovery_allowance_native').notNull(),
  maxReservationNative: native('max_reservation_native').notNull(),
  createdAt: created(),
}, (table) => [
  check('campaigns_status', sql`${table.status} IN ('draft', 'active', 'paused', 'ended')`),
  check('campaigns_schedule', sql`${table.endsAt} > ${table.startsAt}`),
  check('campaigns_budget', sql`${table.capNative} > 0 AND ${table.reservedNative} >= 0 AND ${table.spentNative} >= 0 AND ${table.capNative} >= ${table.reservedNative} + ${table.spentNative} AND ${table.capNative} <> 'NaN'::numeric AND ${table.reservedNative} <> 'NaN'::numeric AND ${table.spentNative} <> 'NaN'::numeric`),
  check('campaigns_capacity', sql`${table.maxUsers} > 0 AND ${table.reservedUsers} >= 0 AND ${table.consumedUsers} >= 0 AND ${table.maxUsers}::bigint >= ${table.reservedUsers}::bigint + ${table.consumedUsers}::bigint`),
  check('campaigns_limits', sql`${table.maxRegistrationPriceNative} > 0 AND ${table.maxTransactionFeeNative} > 0 AND ${table.recoveryAllowanceNative} > 0 AND ${table.maxReservationNative} > 0 AND ${table.maxReservationNative} <= ${table.capNative} AND ${table.maxRegistrationPriceNative} <> 'NaN'::numeric AND ${table.maxTransactionFeeNative} <> 'NaN'::numeric AND ${table.recoveryAllowanceNative} <> 'NaN'::numeric AND ${table.maxReservationNative} <> 'NaN'::numeric`),
  check('campaigns_sponsor', sql`${table.sponsorPublicKey} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`),
  check('campaigns_slug', sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{0,79}$'`),
]);

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
  tokenHash: text('token_hash').notNull().unique(),
  expectedWallet: text('expected_wallet').notNull(),
  status: text('status').$type<InviteStatus>().notNull(),
  expiresAt: time('expires_at').notNull(),
  // The service holds the invite lock and checks the matching attempt identity.
  activeAttemptId: uuid('active_attempt_id').references((): AnyPgColumn => attempts.id),
  consumedAt: time('consumed_at'),
  createdAt: created(),
}, (table) => [
  unique('invites_campaign_wallet_unique').on(table.campaignId, table.expectedWallet),
  unique('invites_id_campaign_unique').on(table.id, table.campaignId),
  check('invites_status', sql`${table.status} IN ('active', 'revoked', 'consumed')`),
  check('invites_token_hash', sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`),
  check('invites_expected_wallet', sql`${table.expectedWallet} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`),
]);

export const capabilitySessions = pgTable('capability_sessions', {
  id: uuid('id').primaryKey(),
  inviteId: uuid('invite_id').notNull().references(() => invites.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: time('expires_at').notNull(),
  revokedAt: time('revoked_at'),
  createdAt: created(),
}, (table) => [
  index('capability_sessions_invite_idx').on(table.inviteId),
  check('capability_sessions_token_hash', sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`),
]);

export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
  inviteId: uuid('invite_id').notNull(),
  wallet: text('wallet').notNull(),
  name: text('name').notNull(),
  payload: jsonb('payload').$type<SponsoredQuote>().notNull(),
  encryptedPayerKey: text('encrypted_payer_key'),
  status: text('status').$type<QuoteStatus>().notNull(),
  expiresAt: time('expires_at').notNull(),
  createdAt: created(),
}, (table) => [
  foreignKey({ name: 'quotes_invite_campaign_fk', columns: [table.inviteId, table.campaignId], foreignColumns: [invites.id, invites.campaignId] }),
  unique('quotes_id_campaign_invite_unique').on(table.id, table.campaignId, table.inviteId),
  index('quotes_invite_idx').on(table.inviteId),
  check('quotes_status', sql`${table.status} IN ('quoted', 'reserved', 'expired')`),
  check('quotes_wallet', sql`${table.wallet} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`),
  check('quotes_name', sql`${table.name} ~ '^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$'`),
]);

export const attempts = pgTable('attempts', {
  id: uuid('id').primaryKey(),
  quoteId: uuid('quote_id').notNull().unique(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
  inviteId: uuid('invite_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  wallet: text('wallet').notNull(),
  name: text('name').notNull(),
  payerPublicKey: text('payer_public_key').notNull().unique(),
  status: text('status').$type<AttemptStatus>().notNull(),
  reservationNative: native('reservation_native').notNull(),
  encryptedPayerKey: text('encrypted_payer_key'),
  messageHash: text('message_hash').notNull(),
  unsignedTransactionBase64: text('unsigned_transaction_base64').notNull(),
  blockhash: text('blockhash').notNull(),
  lastValidBlockHeight: numeric('last_valid_block_height', { precision: 20, scale: 0 }).notNull(),
  expiresAt: time('expires_at').notNull(),
  createdAt: created(),
  updatedAt: time('updated_at').defaultNow().notNull(),
}, (table) => [
  foreignKey({ name: 'attempts_quote_campaign_invite_fk', columns: [table.quoteId, table.campaignId, table.inviteId], foreignColumns: [quotes.id, quotes.campaignId, quotes.inviteId] }),
  unique('attempts_id_campaign_unique').on(table.id, table.campaignId),
  unique('attempts_invite_idempotency_unique').on(table.inviteId, table.idempotencyKey),
  uniqueIndex('attempts_active_invite_unique').on(table.inviteId).where(sql`${table.status} NOT IN ('complete', 'failed', 'expired')`),
  uniqueIndex('attempts_active_campaign_wallet_unique').on(table.campaignId, table.wallet).where(sql`${table.status} NOT IN ('complete', 'failed', 'expired')`),
  uniqueIndex('attempts_active_name_unique').on(table.name).where(sql`${table.status} NOT IN ('complete', 'failed', 'expired')`),
  index('attempts_status_expiry_idx').on(table.status, table.expiresAt),
  check('attempts_quote_identity', sql`${table.id} = ${table.quoteId}`),
  check('attempts_status', sql`${table.status} IN ('prepared', 'signing', 'signed', 'submitted', 'broadcast_unknown', 'confirmed', 'finalized', 'manual_review', 'complete', 'failed', 'expired')`),
  check('attempts_reservation', sql`${table.reservationNative} > 0 AND ${table.reservationNative} <> 'NaN'::numeric`),
  check('attempts_wallet', sql`${table.wallet} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`),
  check('attempts_payer', sql`${table.payerPublicKey} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`),
  check('attempts_blockhash', sql`${table.blockhash} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`),
  check('attempts_message_hash', sql`${table.messageHash} ~ '^[a-f0-9]{64}$'`),
  check('attempts_block_height', sql`${table.lastValidBlockHeight} >= 0 AND ${table.lastValidBlockHeight} <> 'NaN'::numeric`),
  check('attempts_name', sql`${table.name} ~ '^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$'`),
  check('attempts_idempotency_key', sql`length(${table.idempotencyKey}) BETWEEN 1 AND 128`),
]);

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
  attemptId: uuid('attempt_id').notNull(),
  eventKey: text('event_key').notNull().unique(),
  type: text('type').$type<LedgerEntryType>().notNull(),
  amountNative: native('amount_native').notNull(),
  createdAt: created(),
}, (table) => [
  foreignKey({ name: 'ledger_attempt_campaign_fk', columns: [table.attemptId, table.campaignId], foreignColumns: [attempts.id, attempts.campaignId] }),
  index('ledger_entries_campaign_idx').on(table.campaignId),
  index('ledger_entries_attempt_idx').on(table.attemptId),
  check('ledger_entries_type', sql`${table.type} IN ('reserve', 'release', 'debit', 'fee', 'recovery')`),
  check('ledger_entries_amount', sql`${table.amountNative} > 0 AND ${table.amountNative} <> 'NaN'::numeric`),
]);

export const rateLimits = pgTable('rate_limits', {
  key: text('key').notNull(),
  windowStart: bigint('window_start', { mode: 'number' }).notNull(),
  count: integer('count').notNull(),
  expiresAt: time('expires_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.key, table.windowStart] }),
  index('rate_limits_expiry_idx').on(table.expiresAt),
  check('rate_limits_count', sql`${table.count} >= 0`),
  check('rate_limits_window', sql`${table.windowStart} >= 0 AND ${table.windowStart} <= 9007199254740991`),
]);
