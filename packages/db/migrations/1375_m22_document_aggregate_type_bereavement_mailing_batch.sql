-- compat: expand
-- ADR-0109 D10 - M22 `document_aggregate_type`: the INTERNAL bereavement mailing batch.
--   * `bereavement_mailing_batch` - the batch PDF M16's generate worker renders for one mailing run (aggregate = the run). It holds EVERY recipient's
--     name and mailing address, so it is internal-only like the physician letter and the discharge summary (1347): read by role (the scope-bypass roles and
--     bereavement oversight), never by caseload membership, never patient-facing, never in the portal, render-only (no hand write).
-- Own migration: PG forbids using a value added earlier in the same transaction (the 1347 / 0196 precedent). Additive only.
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'bereavement_mailing_batch';
