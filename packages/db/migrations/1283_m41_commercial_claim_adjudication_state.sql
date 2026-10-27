-- M41 Billing - Commercial: the adjudication states and the payer ICN (ADR-0100 D8 amendment, #835).
--
--   commercial_claim        state widens with `paid`, `partially_paid`, `denied`: written ONLY by the M41 consumer of the M25
--                           835 posting events (m25.remittance.claim_paid / claim_partial_paid / claim_denied). A new nullable
--                           payer_icn (the payer's own claim number, 835 CLP07) is captured from the first posted line, so a
--                           later line that carries only the ICN (a correction, a reversal, a reprocess) can bind to the claim.
--   commercial_claim_state_history  same widened sets.
--
-- No new table: the three-column rule, FORCEd RLS and the write-audit trigger on commercial_claim are unchanged. payer_icn is a
-- lookup key per tenant: a partial index on (organization_id, payer_icn). It is deliberately NOT unique (two payers may reuse a
-- number; the reader also filters on the plan's payer, and an ambiguous ICN never auto-binds).
--
-- Legal moves (the trigger is the backstop, domain/remittance-transition.ts is the rule): a SENT claim (submitted, ack_pending,
-- accepted) may move to any adjudication state, because an 835 can arrive before the payer's acknowledgment; partially_paid ->
-- paid; denied -> paid | partially_paid (appeal or reprocess). Nothing leaves paid; partially_paid never becomes denied.

ALTER TABLE "commercial_claim" ADD COLUMN IF NOT EXISTS "payer_icn" text;--> statement-breakpoint
ALTER TABLE "commercial_claim" DROP CONSTRAINT IF EXISTS "commercial_claim_payer_icn_check";--> statement-breakpoint
ALTER TABLE "commercial_claim" ADD CONSTRAINT "commercial_claim_payer_icn_check" CHECK ("payer_icn" IS NULL OR "payer_icn" ~ '^[A-Za-z0-9._ -]{1,50}$');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_payer_icn_ix" ON "commercial_claim" ("organization_id", "payer_icn") WHERE "payer_icn" IS NOT NULL;--> statement-breakpoint
GRANT UPDATE ("payer_icn") ON "commercial_claim" TO chartwarden_app;--> statement-breakpoint

ALTER TABLE "commercial_claim" DROP CONSTRAINT IF EXISTS "commercial_claim_state_check";--> statement-breakpoint
ALTER TABLE "commercial_claim" ADD CONSTRAINT "commercial_claim_state_check" CHECK ("state" IN ('draft','ready','submitted','ack_pending','accepted','rejected','paid','partially_paid','denied','void'));--> statement-breakpoint
ALTER TABLE "commercial_claim_state_history" DROP CONSTRAINT IF EXISTS "commercial_claim_state_history_from_state_check";--> statement-breakpoint
ALTER TABLE "commercial_claim_state_history" ADD CONSTRAINT "commercial_claim_state_history_from_state_check" CHECK ("from_state" IS NULL OR "from_state" IN ('draft','ready','submitted','ack_pending','accepted','rejected','paid','partially_paid','denied','void'));--> statement-breakpoint
ALTER TABLE "commercial_claim_state_history" DROP CONSTRAINT IF EXISTS "commercial_claim_state_history_to_state_check";--> statement-breakpoint
ALTER TABLE "commercial_claim_state_history" ADD CONSTRAINT "commercial_claim_state_history_to_state_check" CHECK ("to_state" IN ('draft','ready','submitted','ack_pending','accepted','rejected','paid','partially_paid','denied','void'));--> statement-breakpoint

CREATE OR REPLACE FUNCTION m41_commercial_claim_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.state <> OLD.state AND OLD.state = 'void' THEN
    RAISE EXCEPTION 'M41_CLAIM_VOID_IS_FINAL: claim % is void and cannot change state', OLD.id;
  END IF;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.state = 'draft' AND NEW.state IN ('ready', 'void'))
    OR (OLD.state = 'ready' AND NEW.state IN ('draft', 'submitted', 'void'))
    OR (OLD.state = 'submitted' AND NEW.state IN ('ack_pending', 'accepted', 'rejected', 'paid', 'partially_paid', 'denied'))
    OR (OLD.state = 'ack_pending' AND NEW.state IN ('accepted', 'rejected', 'paid', 'partially_paid', 'denied'))
    OR (OLD.state = 'accepted' AND NEW.state IN ('paid', 'partially_paid', 'denied'))
    OR (OLD.state = 'partially_paid' AND NEW.state = 'paid')
    OR (OLD.state = 'denied' AND NEW.state IN ('paid', 'partially_paid'))
    OR (OLD.state = 'rejected' AND NEW.state = 'void')
  ) THEN
    RAISE EXCEPTION 'M41_CLAIM_ILLEGAL_TRANSITION: claim % cannot move from % to %', OLD.id, OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END $fn$;
