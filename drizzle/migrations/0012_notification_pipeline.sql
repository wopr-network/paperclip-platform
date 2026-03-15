-- notification_queue: queues system emails with retry support
CREATE TABLE IF NOT EXISTS "notification_queue" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "email_type" text NOT NULL,
  "recipient_email" text NOT NULL,
  "payload" text NOT NULL DEFAULT '{}',
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 5,
  "last_attempt_at" bigint,
  "last_error" text,
  "retry_after" bigint,
  "created_at" bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
  "sent_at" bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nq_status_idx" ON "notification_queue" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nq_tenant_idx" ON "notification_queue" ("tenant_id");
--> statement-breakpoint

-- notification_preferences: per-tenant notification opt-in/out flags
CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "tenant_id" text PRIMARY KEY NOT NULL,
  "billing_low_balance" boolean NOT NULL DEFAULT true,
  "billing_receipts" boolean NOT NULL DEFAULT true,
  "billing_auto_topup" boolean NOT NULL DEFAULT true,
  "agent_channel_disconnect" boolean NOT NULL DEFAULT true,
  "agent_status_changes" boolean NOT NULL DEFAULT false,
  "account_role_changes" boolean NOT NULL DEFAULT true,
  "account_team_invites" boolean NOT NULL DEFAULT true,
  "fleet_updates" boolean NOT NULL DEFAULT true,
  "updated_at" bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
);
