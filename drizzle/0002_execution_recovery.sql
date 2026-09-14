CREATE TABLE "execution_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"operation_id" uuid,
	"event" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_audit_event" CHECK ("execution_audit"."event" IN ('signing_authorized', 'payload_persisted', 'broadcast_attempted', 'broadcast_uncertain', 'confirmed', 'settled', 'manual_review', 'recovery_reserved', 'retry_requested'))
);
--> statement-breakpoint
CREATE TABLE "execution_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" uuid,
	"lease_expires_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_jobs_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "execution_jobs_retry_count" CHECK ("execution_jobs"."retry_count" >= 0),
	CONSTRAINT "execution_jobs_lease" CHECK (("execution_jobs"."lease_owner" IS NULL) = ("execution_jobs"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "execution_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"message_hash" text NOT NULL,
	"message_base64" text NOT NULL,
	"encrypted_user_payload" text,
	"encrypted_signed_payload" text,
	"signature" text,
	"blockhash" text NOT NULL,
	"last_valid_block_height" numeric(20, 0) NOT NULL,
	"fee_cap_native" numeric(24, 0) NOT NULL,
	"amount_native" numeric(24, 0) NOT NULL,
	"actual_fee_native" numeric(24, 0),
	"actual_debit_native" numeric(24, 0),
	"recovered_native" numeric(24, 0),
	"evidence" jsonb,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_operations_signature_unique" UNIQUE("signature"),
	CONSTRAINT "execution_operations_kind" CHECK ("execution_operations"."kind" IN ('registration', 'recovery')),
	CONSTRAINT "execution_operations_status" CHECK ("execution_operations"."status" IN ('signing', 'signed', 'submitted', 'broadcast_unknown', 'confirmed', 'finalized', 'manual_review', 'complete', 'failed', 'expired')),
	CONSTRAINT "execution_operations_message_hash" CHECK ("execution_operations"."message_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "execution_operations_blockhash" CHECK ("execution_operations"."blockhash" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "execution_operations_signature" CHECK ("execution_operations"."signature" ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
	CONSTRAINT "execution_operations_block_height" CHECK ("execution_operations"."last_valid_block_height" >= 0 AND "execution_operations"."last_valid_block_height" <> 'NaN'::numeric),
	CONSTRAINT "execution_operations_fee_cap" CHECK ("execution_operations"."fee_cap_native" > 0 AND "execution_operations"."fee_cap_native" <> 'NaN'::numeric),
	CONSTRAINT "execution_operations_amount" CHECK ("execution_operations"."amount_native" >= 0 AND "execution_operations"."amount_native" <> 'NaN'::numeric),
	CONSTRAINT "execution_operations_actual_fee" CHECK ("execution_operations"."actual_fee_native" >= 0 AND "execution_operations"."actual_fee_native" <> 'NaN'::numeric),
	CONSTRAINT "execution_operations_actual_debit" CHECK ("execution_operations"."actual_debit_native" >= 0 AND "execution_operations"."actual_debit_native" <> 'NaN'::numeric),
	CONSTRAINT "execution_operations_recovered" CHECK ("execution_operations"."recovered_native" >= 0 AND "execution_operations"."recovered_native" <> 'NaN'::numeric)
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "remaining_reservation_native" numeric(24, 0) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "actual_cost_native" numeric(24, 0) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "residual_native" numeric(24, 0);--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "recovery_next_run_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "attempts_recovery_schedule_idx" ON "attempts" USING btree ("recovery_next_run_at");--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "verified_slot" bigint;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "tx_signature" text;--> statement-breakpoint
ALTER TABLE "execution_audit" ADD CONSTRAINT "execution_audit_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_audit" ADD CONSTRAINT "execution_audit_operation_id_execution_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "execution_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_operation_id_execution_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "execution_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_operations" ADD CONSTRAINT "execution_operations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_operations" ADD CONSTRAINT "execution_operations_attempt_campaign_fk" FOREIGN KEY ("attempt_id","campaign_id") REFERENCES "attempts"("id","campaign_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_audit_attempt_idx" ON "execution_audit" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "execution_audit_operation_idx" ON "execution_audit" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "execution_jobs_next_run_idx" ON "execution_jobs" USING btree ("next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_operations_registration_unique" ON "execution_operations" USING btree ("attempt_id") WHERE "execution_operations"."kind" = 'registration';--> statement-breakpoint
CREATE UNIQUE INDEX "execution_operations_active_recovery_unique" ON "execution_operations" USING btree ("attempt_id") WHERE "execution_operations"."kind" = 'recovery' AND "execution_operations"."status" NOT IN ('complete', 'failed', 'expired');--> statement-breakpoint
CREATE INDEX "execution_operations_campaign_idx" ON "execution_operations" USING btree ("campaign_id");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_operation_id_execution_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "execution_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_signature_unique" UNIQUE("signature");--> statement-breakpoint
-- Preserve all reservations held before the execution migration. Terminal
-- attempts released their reservation in the Phase 3 store.
UPDATE "attempts" SET "remaining_reservation_native" = "reservation_native"
WHERE "status" NOT IN ('complete', 'failed', 'expired');
--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_remaining_reservation" CHECK ("attempts"."remaining_reservation_native" >= 0 AND "attempts"."remaining_reservation_native" <> 'NaN'::numeric);--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_actual_cost" CHECK ("attempts"."actual_cost_native" >= 0 AND "attempts"."actual_cost_native" <> 'NaN'::numeric);--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_residual" CHECK ("attempts"."residual_native" >= 0 AND "attempts"."residual_native" <> 'NaN'::numeric);--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_verified_slot" CHECK ("attempts"."verified_slot" >= 0 AND "attempts"."verified_slot" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_signature" CHECK ("attempts"."signature" ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_tx_signature" CHECK ("ledger_entries"."tx_signature" ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');
--> statement-breakpoint
-- Audit evidence is append-only, including accidental bulk deletion. Keep the
-- function and table scoped to the migration connection's current search_path.
CREATE FUNCTION "reject_execution_audit_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Execution audit entries are append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "execution_audit_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "execution_audit"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_execution_audit_mutation"();
--> statement-breakpoint
UPDATE "app_metadata" SET "value" = '{"version":3}'::jsonb WHERE "key" = 'schema_version';
