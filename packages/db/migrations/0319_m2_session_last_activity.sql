-- GAP-002 — server-side session idle timeout (M2 §2.2.4 / D1; HIPAA §164.312(a)(2)(iii)).
--
-- SESSION_POLICY's idle bounds (staff 15 min, auditor 10 min) had no server reader and no column to
-- read: Better Auth only refreshes `expires_at` once a day. The authenticate hook now stamps this
-- column (at most once a minute per session) and deletes a session whose idle or absolute bound has
-- passed. NULL until the first authenticated request; the evaluator falls back to `created_at`.
ALTER TABLE "session" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
-- Sessions that exist at deploy time start their idle clock now, rather than from `created_at` —
-- otherwise every clinician mid-shift is signed out on their first request after the deploy. Their
-- absolute bounds still run from `created_at`.
UPDATE "session" SET "last_activity_at" = now() WHERE "last_activity_at" IS NULL;
