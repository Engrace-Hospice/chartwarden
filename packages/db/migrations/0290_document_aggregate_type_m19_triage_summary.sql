-- M22 `document_aggregate_type` — two new artifact types behind the M19 caregiver/attending triage-summary
-- render handshake (F-217, #248; the 0239 F-099 / 0251 F-144 / 0252 F-161 / 0267 F-192 / 0277 F-208
-- additive-enum precedent, a sixth time).
--
-- `m19.triage.summary_requested` has been declared in M22's own `handlers-unbound` group since the register
-- existed, with no producer. It now has one — the explicit `POST /api/v1/triage-calls/:id/request-summary`
-- staff action — and its payload carries `recipientKind` (caregiver | attending). The two audiences get two
-- DIFFERENT artifacts, so they get two aggregate types (never one shared type: a caregiver version and an
-- attending version must not interleave in one document's version chain, and the portal/mint-time gates key
-- on the type). Each is ONE document per triage call (`aggregate_id` = the call), versioned via the F-168
-- `document_version.source_event_id` mechanism when a summary is re-requested.
--
-- Additive only (no removal, no existing row affected). Own migration: PG forbids using a value added
-- earlier in the same transaction, so this stands alone ahead of any migration that reads or writes it.
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'triage_summary_caregiver';
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'triage_summary_attending';
