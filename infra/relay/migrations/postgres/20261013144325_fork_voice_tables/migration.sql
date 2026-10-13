-- Databases migrated by the fork already have these tables from 20260731110708_add_voice_input.
CREATE TABLE IF NOT EXISTS "relay_voice_input_settings" (
	"user_id" varchar(255) PRIMARY KEY,
	"settings_json" jsonb NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relay_voice_transcription_requests" (
	"user_id" varchar(255),
	"request_id" varchar(191),
	"response_json" jsonb NOT NULL,
	"created_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_voice_transcription_requests_pkey" PRIMARY KEY("user_id","request_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_relay_voice_requests_created" ON "relay_voice_transcription_requests" ("created_at");