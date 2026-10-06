-- Referral intake can record sex assigned at birth. It is nullable for historical referrals and
-- is copied to M5 only when M6 creates a new canonical patient; M5 remains the source of truth.
ALTER TABLE "referral"
ADD COLUMN IF NOT EXISTS "sex_assigned_at_birth" text;
