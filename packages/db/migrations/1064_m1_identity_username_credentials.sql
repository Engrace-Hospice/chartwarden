-- M1/M2 — global username identity and password lifecycle state.
--
-- Existing identities remain email-first: username is nullable and credential_state defaults
-- to active. New administrative provisioning enforces a username at the service boundary.
-- PostgreSQL unique indexes allow multiple NULL values, preserving legacy and username-only users.

CREATE TYPE "credential_state" AS ENUM ('active', 'password_change_required');--> statement-breakpoint

ALTER TABLE "user" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "display_username" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "credential_state" "credential_state" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "credential_state_reason" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "credential_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "password_changed_at" timestamptz;--> statement-breakpoint

CREATE UNIQUE INDEX "user_username_idx" ON "user" ("username");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_username_shape"
  CHECK (
    "username" IS NULL OR (
      "username" = lower("username")
      AND "username" ~ '^[a-z0-9_.-]{3,32}$'
      AND "username" !~ '@'
    )
  );--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_username_not_reserved"
  CHECK (
    "username" IS NULL OR "username" NOT IN
      ('admin', 'administrator', 'root', 'security', 'support', 'system', 'wardenx')
  );

-- Rollback (manual, only after application rollback):
-- 1. Ensure every user has a non-null email before restoring NOT NULL.
-- 2. Drop the username checks/index and the four credential columns.
-- 3. Drop type credential_state.
