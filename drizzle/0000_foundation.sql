CREATE TABLE "app_metadata" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
INSERT INTO "app_metadata" ("key", "value") VALUES ('schema_version', '{"version":1}'::jsonb);
