-- compat: expand
-- M35 (ADR-0108) - subscription_addon.canceled_by_membership_id: the platform operator who canceled the add-on.
--   * The cancel runs on the platform credential, where `app.user_id` is not set, and the M1 baseline write-audit trigger
--     records no actor; so the row names its operator, as `granted_by_membership_id` does for the grant, and the audit
--     row's after-image carries it.
--   * Nullable: an add-on closed by the system (an expired trial or scheduled end) has no operator.
ALTER TABLE "subscription_addon" ADD COLUMN IF NOT EXISTS "canceled_by_membership_id" uuid;
