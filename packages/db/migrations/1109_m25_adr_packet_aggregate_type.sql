-- M22 `document_aggregate_type` — the ADR response packet (hospice ADR/TPE/QIC PRD, milestone 2b). M25 asks M22
-- to render a cover sheet and enclosure index for a filed ADR response; M22 files the rendered document under
-- `(adr_response_packet, <adr_case id>)`. Additive only. Own migration: PG forbids using a value added earlier in
-- the same transaction, so this stands alone ahead of any migration that reads or writes it (the 0239 / 0251
-- precedent).
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'adr_response_packet';
