-- compat: expand
-- ADR-0109 D6 / D9 - M22 `document_aggregate_type`: the two INTERNAL bereavement documents M16 asks M22 to render through
-- `m16.bereavement.document_requested`.
--   * `bereavement_physician_letter`  - the approved condolence letter to the patient's internal attending clinician (aggregate = the letter).
--   * `bereavement_discharge_summary` - the internal discharge summary an auditor reads at closure (aggregate = the closure).
-- Each is its own type, not a template key under `bereavement_letter`: the read path decides on the aggregate type, and these two must
-- never be read by caseload membership or reach the portal (the portal allowlist is fail-closed and does not list them). Additive only.
-- Own migration: PG forbids using a value added earlier in the same transaction, so this stands alone ahead of anything that writes it
-- (the 0196 supply-docs precedent).
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'bereavement_physician_letter';--> statement-breakpoint
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'bereavement_discharge_summary';
