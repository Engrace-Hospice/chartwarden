CREATE TYPE "public"."session_class" AS ENUM('staff', 'auditor', 'external_collaborator', 'funeral_home');--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "session_class" "session_class" DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "scope" jsonb;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "engagement_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "engagement_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "screen_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "last_step_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "last_step_up_factor" "step_up_factor";--> statement-breakpoint
CREATE INDEX "idx_session_step_up_recent" ON "session" USING btree ("last_step_up_at") WHERE "session"."last_step_up_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_scope_chk" CHECK (("session"."session_class" IN ('external_collaborator','funeral_home') AND "session"."scope" ? 'patientId')
        OR ("session"."session_class" = 'auditor' AND "session"."engagement_start" IS NOT NULL AND "session"."engagement_end" IS NOT NULL)
        OR ("session"."session_class" = 'staff'));--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_step_up_paired_write" CHECK (("session"."last_step_up_at" IS NULL AND "session"."last_step_up_factor" IS NULL)
        OR ("session"."last_step_up_at" IS NOT NULL AND "session"."last_step_up_factor" IS NOT NULL));