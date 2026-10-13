CREATE TABLE "relay_account_integrations" (
	"user_id" varchar(255),
	"integration_id" varchar(64),
	"credential_ciphertext" text,
	"credential_hint" varchar(32),
	"state" varchar(32) NOT NULL,
	"last_validated_at" varchar(64),
	"error_code" varchar(64),
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_account_integrations_pkey" PRIMARY KEY("user_id","integration_id")
);
--> statement-breakpoint
CREATE TABLE "relay_voice_input_settings" (
	"user_id" varchar(255) PRIMARY KEY,
	"settings_json" jsonb NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_voice_transcription_requests" (
	"user_id" varchar(255),
	"request_id" varchar(191),
	"response_json" jsonb NOT NULL,
	"created_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_voice_transcription_requests_pkey" PRIMARY KEY("user_id","request_id")
);
--> statement-breakpoint
CREATE INDEX "idx_relay_account_integrations_user" ON "relay_account_integrations" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_relay_voice_requests_created" ON "relay_voice_transcription_requests" ("created_at");