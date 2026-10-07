-- 0471 — M36 GAP-166: store the endpoint verification code (hashed) so `verifyEndpoint` can check it.
--
-- `POST /api/v1/notifications/endpoints/:id/verify` discarded its token and flipped any pending sms/email
-- endpoint to `verified`. The §4.2 OTP needs somewhere to keep the issued code: ONLY a salted SHA-256 is
-- stored (never the code), with an expiry and a wrong-guess counter. All three are nullable / defaulted, so
-- existing rows (push = verified at registration; legacy pending rows) are untouched — a legacy pending row
-- has no hash, so it can no longer be verified until it is re-registered, which is the safe direction.
-- No new RLS: `delivery_endpoint` is a user-owned table already covered by its existing policies, and a
-- column add inherits them.
ALTER TABLE "delivery_endpoint"
  ADD COLUMN IF NOT EXISTS "verification_token_hash" text,
  ADD COLUMN IF NOT EXISTS "verification_token_expires_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "verification_attempts" integer DEFAULT 0 NOT NULL;
