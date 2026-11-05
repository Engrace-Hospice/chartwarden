-- compat: expand
-- ADR-0107 (PROPOSED) - portal admission-document signing needs four new enum values. Purely additive: nothing reads them until the portal sign
-- path (a later PR) writes them, and no existing row changes.
--   * election_signature_method / nor_acknowledgment_method `electronic_portal`: a patient or representative who signs alone in the portal is NOT
--     witnessed. M06 hardcoded `electronic_witnessed` for every electronic election signature, which would put a witness on a CMS audit trail
--     that never existed. The portal path records the method it actually used.
--   * consent_type_key `hipaa_npp_acknowledgement` and `consent_to_treat`: the two M39-backed admission documents (the Election Statement and the
--     Notice of Patient Rights stay M06-backed). The catalog rows are seeded by scripts/db/seed-consent-types.ts, as for every other type.
-- ALTER TYPE ... ADD VALUE is safe in the migration transaction because nothing in this file uses the new values.
ALTER TYPE "public"."election_signature_method" ADD VALUE IF NOT EXISTS 'electronic_portal';--> statement-breakpoint
ALTER TYPE "public"."nor_acknowledgment_method" ADD VALUE IF NOT EXISTS 'electronic_portal';--> statement-breakpoint
ALTER TYPE "public"."consent_type_key" ADD VALUE IF NOT EXISTS 'hipaa_npp_acknowledgement';--> statement-breakpoint
ALTER TYPE "public"."consent_type_key" ADD VALUE IF NOT EXISTS 'consent_to_treat';
