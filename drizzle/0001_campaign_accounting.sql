CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"quote_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"invite_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"wallet" text NOT NULL,
	"name" text NOT NULL,
	"payer_public_key" text NOT NULL,
	"status" text NOT NULL,
	"reservation_native" numeric(24, 0) NOT NULL,
	"encrypted_payer_key" text,
	"message_hash" text NOT NULL,
	"unsigned_transaction_base64" text NOT NULL,
	"blockhash" text NOT NULL,
	"last_valid_block_height" numeric(20, 0) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempts_quote_id_unique" UNIQUE("quote_id"),
	CONSTRAINT "attempts_payer_public_key_unique" UNIQUE("payer_public_key"),
	CONSTRAINT "attempts_id_campaign_unique" UNIQUE("id","campaign_id"),
	CONSTRAINT "attempts_invite_idempotency_unique" UNIQUE("invite_id","idempotency_key"),
	CONSTRAINT "attempts_quote_identity" CHECK ("attempts"."id" = "attempts"."quote_id"),
	CONSTRAINT "attempts_status" CHECK ("attempts"."status" IN ('prepared', 'signing', 'signed', 'submitted', 'broadcast_unknown', 'confirmed', 'finalized', 'manual_review', 'complete', 'failed', 'expired')),
	CONSTRAINT "attempts_reservation" CHECK ("attempts"."reservation_native" > 0 AND "attempts"."reservation_native" <> 'NaN'::numeric),
	CONSTRAINT "attempts_wallet" CHECK ("attempts"."wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "attempts_payer" CHECK ("attempts"."payer_public_key" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "attempts_blockhash" CHECK ("attempts"."blockhash" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "attempts_message_hash" CHECK ("attempts"."message_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "attempts_block_height" CHECK ("attempts"."last_valid_block_height" >= 0 AND "attempts"."last_valid_block_height" <> 'NaN'::numeric),
	CONSTRAINT "attempts_name" CHECK ("attempts"."name" ~ '^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$'),
	CONSTRAINT "attempts_idempotency_key" CHECK (length("attempts"."idempotency_key") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"max_users" integer NOT NULL,
	"cap_native" numeric(24, 0) NOT NULL,
	"reserved_native" numeric(24, 0) DEFAULT '0' NOT NULL,
	"spent_native" numeric(24, 0) DEFAULT '0' NOT NULL,
	"reserved_users" integer DEFAULT 0 NOT NULL,
	"consumed_users" integer DEFAULT 0 NOT NULL,
	"sponsor_public_key" text NOT NULL,
	"policy_version" text NOT NULL,
	"max_registration_price_native" numeric(24, 0) NOT NULL,
	"max_transaction_fee_native" numeric(24, 0) NOT NULL,
	"recovery_allowance_native" numeric(24, 0) NOT NULL,
	"max_reservation_native" numeric(24, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_slug_unique" UNIQUE("slug"),
	CONSTRAINT "campaigns_status" CHECK ("campaigns"."status" IN ('draft', 'active', 'paused', 'ended')),
	CONSTRAINT "campaigns_schedule" CHECK ("campaigns"."ends_at" > "campaigns"."starts_at"),
	CONSTRAINT "campaigns_budget" CHECK ("campaigns"."cap_native" > 0 AND "campaigns"."reserved_native" >= 0 AND "campaigns"."spent_native" >= 0 AND "campaigns"."cap_native" >= "campaigns"."reserved_native" + "campaigns"."spent_native" AND "campaigns"."cap_native" <> 'NaN'::numeric AND "campaigns"."reserved_native" <> 'NaN'::numeric AND "campaigns"."spent_native" <> 'NaN'::numeric),
	CONSTRAINT "campaigns_capacity" CHECK ("campaigns"."max_users" > 0 AND "campaigns"."reserved_users" >= 0 AND "campaigns"."consumed_users" >= 0 AND "campaigns"."max_users"::bigint >= "campaigns"."reserved_users"::bigint + "campaigns"."consumed_users"::bigint),
	CONSTRAINT "campaigns_limits" CHECK ("campaigns"."max_registration_price_native" > 0 AND "campaigns"."max_transaction_fee_native" > 0 AND "campaigns"."recovery_allowance_native" > 0 AND "campaigns"."max_reservation_native" > 0 AND "campaigns"."max_reservation_native" <= "campaigns"."cap_native" AND "campaigns"."max_registration_price_native" <> 'NaN'::numeric AND "campaigns"."max_transaction_fee_native" <> 'NaN'::numeric AND "campaigns"."recovery_allowance_native" <> 'NaN'::numeric AND "campaigns"."max_reservation_native" <> 'NaN'::numeric),
	CONSTRAINT "campaigns_sponsor" CHECK ("campaigns"."sponsor_public_key" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "campaigns_slug" CHECK ("campaigns"."slug" ~ '^[a-z0-9][a-z0-9-]{0,79}$')
);
--> statement-breakpoint
CREATE TABLE "capability_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invite_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "capability_sessions_token_hash" CHECK ("capability_sessions"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expected_wallet" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"active_attempt_id" uuid,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invites_campaign_wallet_unique" UNIQUE("campaign_id","expected_wallet"),
	CONSTRAINT "invites_id_campaign_unique" UNIQUE("id","campaign_id"),
	CONSTRAINT "invites_status" CHECK ("invites"."status" IN ('active', 'revoked', 'consumed')),
	CONSTRAINT "invites_token_hash" CHECK ("invites"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "invites_expected_wallet" CHECK ("invites"."expected_wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"type" text NOT NULL,
	"amount_native" numeric(24, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_event_key_unique" UNIQUE("event_key"),
	CONSTRAINT "ledger_entries_type" CHECK ("ledger_entries"."type" IN ('reserve', 'release', 'debit', 'fee', 'recovery')),
	CONSTRAINT "ledger_entries_amount" CHECK ("ledger_entries"."amount_native" > 0 AND "ledger_entries"."amount_native" <> 'NaN'::numeric)
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"invite_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"encrypted_payer_key" text,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_id_campaign_invite_unique" UNIQUE("id","campaign_id","invite_id"),
	CONSTRAINT "quotes_status" CHECK ("quotes"."status" IN ('quoted', 'reserved', 'expired')),
	CONSTRAINT "quotes_wallet" CHECK ("quotes"."wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "quotes_name" CHECK ("quotes"."name" ~ '^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$')
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" bigint NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start"),
	CONSTRAINT "rate_limits_count" CHECK ("rate_limits"."count" >= 0),
	CONSTRAINT "rate_limits_window" CHECK ("rate_limits"."window_start" >= 0 AND "rate_limits"."window_start" <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_quote_campaign_invite_fk" FOREIGN KEY ("quote_id","campaign_id","invite_id") REFERENCES "quotes"("id","campaign_id","invite_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_sessions" ADD CONSTRAINT "capability_sessions_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "invites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_active_attempt_id_attempts_id_fk" FOREIGN KEY ("active_attempt_id") REFERENCES "attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_attempt_campaign_fk" FOREIGN KEY ("attempt_id","campaign_id") REFERENCES "attempts"("id","campaign_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_invite_campaign_fk" FOREIGN KEY ("invite_id","campaign_id") REFERENCES "invites"("id","campaign_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_active_invite_unique" ON "attempts" USING btree ("invite_id") WHERE "attempts"."status" NOT IN ('complete', 'failed', 'expired');--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_active_campaign_wallet_unique" ON "attempts" USING btree ("campaign_id","wallet") WHERE "attempts"."status" NOT IN ('complete', 'failed', 'expired');--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_active_name_unique" ON "attempts" USING btree ("name") WHERE "attempts"."status" NOT IN ('complete', 'failed', 'expired');--> statement-breakpoint
CREATE INDEX "attempts_status_expiry_idx" ON "attempts" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "capability_sessions_invite_idx" ON "capability_sessions" USING btree ("invite_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_campaign_idx" ON "ledger_entries" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_attempt_idx" ON "ledger_entries" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "quotes_invite_idx" ON "quotes" USING btree ("invite_id");--> statement-breakpoint
CREATE INDEX "rate_limits_expiry_idx" ON "rate_limits" USING btree ("expires_at");
--> statement-breakpoint
-- Keep the ledger append-only, including accidental bulk deletion. The function
-- and table use the current search_path so isolated test schemas stay isolated.
CREATE FUNCTION "reject_ledger_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ledger entries are append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "ledger_entries"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_ledger_mutation"();
--> statement-breakpoint
UPDATE "app_metadata" SET "value" = '{"version":2}'::jsonb WHERE "key" = 'schema_version';
