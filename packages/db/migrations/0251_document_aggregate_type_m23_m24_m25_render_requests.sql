-- M22 `document_aggregate_type` — six artifact types behind three catalogued render-request events that
-- had never been emitted by anything (F-144, #248; the 0239 F-099 precedent, a second time).
--
-- M23's own §4.10 table names `m23.billing.document_render_requested` as the SOLE M22 handshake for its
-- four document kinds (`consumers/document-render.ts`'s four typed builders — `noe_confirmation_receipt`,
-- `notr_confirmation_receipt`, `claim_acknowledgment_letter`, `denial_appeal_cover_letter` — had every
-- builder and no caller). M24's own §4.10 table names the identical `m24.medicaid_billing
-- .document_render_requested` handshake for the one M24 document kind this pass builds a producer for
-- (`medicaid_claim_acknowledgment_letter`; the other three the M24 spec names — R&B contract summary,
-- remittance summary, denial-appeal cover letter — stay unbuilt, no producer transition exists for them
-- yet). M25's own module dependency text names `m25.denial_resolution_letter.render_requested` alongside
-- the already-live-bound `m25.appeal_packet.render_requested` — the resolution-letter half was catalogued
-- and never emitted either.
--
-- Each of the six is a DISTINCT type rather than a shared "notice_receipt" bucket, the same reasoning
-- 0239 used for M27's three cost-report artifact kinds: each is separately retained, separately
-- superseded, and a shared type would make a second kind's render read as an idempotent re-delivery of
-- the first against the same `(sourceEvent, aggregateId)` — which cannot collide here regardless (the
-- source events differ per module), but keeping one type per kind is the established, unambiguous
-- convention this table already follows throughout.
--
-- Additive only (no removal, no existing row affected). Own migration: PG forbids using a value added
-- earlier in the same transaction, so this stands alone ahead of any migration that reads or writes it.
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'noe_confirmation_receipt';--> statement-breakpoint
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'notr_confirmation_receipt';--> statement-breakpoint
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'claim_acknowledgment_letter';--> statement-breakpoint
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'denial_appeal_cover_letter';--> statement-breakpoint
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'medicaid_claim_acknowledgment_letter';--> statement-breakpoint
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'denial_resolution_letter';
