-- M22 `document_aggregate_type` - the audit response packet (hospice ADR/TPE/QIC PRD, milestone 7a-2). M25 asks M22 to
-- render a cover sheet and enclosure index for a filed RAC / UPIC / SMRC / other audit response; M22 files the rendered
-- document under `(audit_response_packet, <audit_request id>)`. Additive only. Own migration: PG forbids using a value
-- added earlier in the same transaction, so this stands alone ahead of any migration that reads or writes it (the
-- 1109 / 0239 / 0251 precedent). Idempotent.
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'audit_response_packet';
