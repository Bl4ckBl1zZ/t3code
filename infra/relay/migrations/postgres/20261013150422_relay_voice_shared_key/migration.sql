-- The relay transcribes with one shared key now; per-user OpenRouter keys are deleted.
-- Only databases migrated by the fork have this table.
DROP TABLE IF EXISTS "relay_account_integrations";
--> statement-breakpoint
CREATE TABLE "relay_voice_usage_days" (
	"user_id" varchar(255),
	"day" varchar(10),
	"audio_seconds" integer NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_voice_usage_days_pkey" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE INDEX "idx_relay_voice_usage_days_day" ON "relay_voice_usage_days" ("day");
