-- F-193 (#248) — M21's OWN caregiver-signature CAPTURE, closing the gap F-191 surfaced.
--
-- F-191 (already committed, see events-by-m21.ts's comment on `m21.supply_request.delivered`) fixed the
-- outbox-catalog MISTAKE: `m22` was declared a consumer of the delivery event for signature capture, but
-- M22's own spec explicitly disclaims owning signature capture ("M22 does not capture signatures — the
-- source module does") and no capture route/seam/consumer exists anywhere in `22-documents/`. Dropping
-- the misdeclared consumer was correct, but it left the REAL gap exactly where it always was: M21's own
-- spec (WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md, D7) says "Caregiver signature is
-- optional via M22's signature flow, triggered when policy or tenant config requires it" — a mechanism
-- M22 was never going to build and M21 itself has never built either. `supply_request.data`'s draft
-- `caregiverSignatureRequestId` concept was dangling (no FK, nothing wired to it); this migration builds
-- the real, minimal thing instead of that placeholder.
--
-- SCOPE (deliberately narrow — see the F-193 build brief): this is the CAPTURE capability only. Nothing
-- here makes a caregiver signature REQUIRED before anything (D7's "triggered when policy or tenant config
-- requires it" describes a requirement-gating mechanism this migration does NOT build — that is a
-- separate, larger product decision about what policy surface exists and what happens when a signature is
-- required-but-missing). A signature is always optional and capturable whenever provided, full stop.
--
-- SHAPE mirrors the ALREADY-BUILT, proven precedent for exactly this kind of record in this codebase:
-- `packages/consent/src/routes/service.ts`'s `ConsentCaptureEvidence` (M39) — a `captureMethod` enum plus
-- evidence fields including a reference to an already-rendered M22 document. NOT the literal M39 type:
-- M21's manifest `dependsOn` is [1, 11, 40] with no edge to 39, so M21 cannot import `@chartwarden/consent`'s
-- types; this is M21's own local equivalent (`apps/backend/src/modules/21-supplies/lifecycle/
-- caregiver-signature.ts`), narrowed to what is plausible for a courier-delivery caregiver signature:
-- `typed_signature_in_app` / `witnessed_verbal_documented` / `declined` — no portal session (no patient
-- portal interaction at the doorstep), no uploaded PDF (no scan workflow here), no notary (irrelevant to
-- a delivery receipt).
--
-- COLUMNS ON THE ROW, NOT A CHILD TABLE — this table's OWN existing precedent for a delivery-adjacent
-- evidentiary fact is the D7 courier attestation immediately above these columns in the Drizzle schema:
-- four discrete columns (`delivered_at` / `delivered_by_membership_id` / `delivery_method` /
-- `delivery_evidence_document_id`), not a jsonb blob and not a separate table (the migration 0104 header
-- explicitly rejected a `courier_attestation_jsonb` fold as "a jsonb copy of columns that already exist is
-- a second source of truth"). This migration follows the SAME shape: `caregiver_signature_capture_method`
-- / `_captured_at` / `_captured_by_membership_id` / `_evidence_document_id` are the discrete facts, and
-- `caregiver_signature_evidence_jsonb` carries ONLY the method-specific free text a discrete column
-- cannot (a typed name, a witness name + attestation text, a decline reason) — the same division M39's
-- own `consent_record` makes between its discrete `capture_method` column and its `capture_evidence_jsonb`
-- column.
--
-- RESUBMISSION: the write service (`routes/write-service-drizzle.ts`) REJECTS a second capture attempt
-- (`M21_CAREGIVER_SIGNATURE_ALREADY_CAPTURED`, 409) rather than overwriting or appending — once captured,
-- the evidentiary record is immutable, matching this module's append-only posture for every other
-- attestation (the DEA perpetual log, `order_transmission_attestation`). This migration does not need to
-- enforce that at the DB level: the paired CHECK below only guarantees the three top-level facts are
-- written together, and the immutability rule is a service-layer read-before-write decision the RLS/CHECK
-- layer cannot express any more cleanly than a `SELECT ... FOR UPDATE` already gives it.
--
-- `supply_request` is PARTITIONED BY RANGE (created_at, migration 0104); ALTER TABLE on the PARENT
-- propagates the new columns to every leaf (PG11+, the 0266/0131 precedent). No new FK: the evidence
-- document id is a LOGICAL M22 reference, validated at the write boundary, matching
-- `delivery_evidence_document_id` immediately above it.
CREATE TYPE "public"."m21_caregiver_signature_capture_method" AS ENUM(
  'typed_signature_in_app', 'witnessed_verbal_documented', 'declined'
);--> statement-breakpoint

ALTER TABLE "supply_request"
  ADD COLUMN IF NOT EXISTS "caregiver_signature_capture_method" "m21_caregiver_signature_capture_method";--> statement-breakpoint
ALTER TABLE "supply_request"
  ADD COLUMN IF NOT EXISTS "caregiver_signature_captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supply_request"
  ADD COLUMN IF NOT EXISTS "caregiver_signature_captured_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "supply_request"
  ADD COLUMN IF NOT EXISTS "caregiver_signature_evidence_document_id" uuid;--> statement-breakpoint
ALTER TABLE "supply_request"
  ADD COLUMN IF NOT EXISTS "caregiver_signature_evidence_jsonb" jsonb;--> statement-breakpoint

-- The three top-level capture facts move together, both ways — an incomplete write (a method with no
-- timestamp/actor, or vice versa) can never land. The method-specific evidence SHAPE (does a typed method
-- carry a typed name? does a witnessed method carry both a witness name and an evidence document?) is
-- deliberately left to the app-layer pure validator, not this CHECK — jsonb sub-key validation in SQL
-- would duplicate `caregiverSignatureEvidenceSatisfiesMethod` as a second, driftable copy of the same rule.
ALTER TABLE "supply_request" ADD CONSTRAINT "m21_caregiver_signature_paired" CHECK (
  ("caregiver_signature_capture_method" IS NULL
     AND "caregiver_signature_captured_at" IS NULL
     AND "caregiver_signature_captured_by_membership_id" IS NULL)
  OR
  ("caregiver_signature_capture_method" IS NOT NULL
     AND "caregiver_signature_captured_at" IS NOT NULL
     AND "caregiver_signature_captured_by_membership_id" IS NOT NULL)
);--> statement-breakpoint

-- Extend migration 0106's M4 write-audit trigger denylist: `caregiver_signature_evidence_jsonb` can carry
-- a typed or witness NAME (free text, by construction — the whole point of the field), so it is scrubbed
-- from the audit diff the same way `delivery_instructions` / `cancellation_reason` already are. The row
-- itself (not the audit diff) stays the durable evidentiary record; `packages/types/src/supplies.ts`'s
-- `M21_AUDIT_DENYLIST.supply_request` and `scripts/check-audit-denylist-sync.ts`'s M21 migration list are
-- updated in the SAME change so the enforced-sync gate (arch:audit-denylist-sync) stays green.
CREATE OR REPLACE FUNCTION audit_phi_write_supply_request() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['delivery_instructions','cancellation_reason','caregiver_signature_evidence_jsonb']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'supply_request.' || lower(TG_OP),
    'supply_request',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_supply_request() OWNER TO wardenx_audit_writer;--> statement-breakpoint
-- Re-affirms the existing trigger→function binding (the function body above is what actually changed;
-- CREATE OR REPLACE FUNCTION alone would suffice) — restating it keeps this migration self-contained and
-- matches what scripts/check-audit-denylist-sync.ts parses per-file (the 0163 precedent).
CREATE OR REPLACE TRIGGER "trg_audit_supply_request" AFTER INSERT OR UPDATE OR DELETE ON supply_request
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_supply_request();
