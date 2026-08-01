-- M1 Foundation §3.10 — `idempotency_key` gains the in-flight state the port has always modelled.
--
-- `IdempotencyStore` (packages/shared/src/idempotency) stores a record that is either `pending` (a
-- first request is still running) or `complete` (its response is cached for replay). The table could
-- only express the second: `response_status` / `response_body` are NOT NULL, so there was nowhere to
-- record "claimed, still running" — which is exactly the row that makes concurrent duplicates
-- serialize instead of both executing.
--
-- WHY IT MATTERS NOW. `bootstrap/index.ts` defaulted to `createInMemoryIdempotencyStore()` and the
-- composition root never passed another, so on the production mount every `Idempotency-Key` lived in
-- a process-local Map: a retry that landed on a different replica re-ran the mutation, and the whole
-- table was empty. For the M23/M26/M30 write surfaces that carry a required Idempotency-Key, that is
-- a duplicated claim submission or a duplicated cap settlement, not a cosmetic miss.
--
-- `state` defaults to 'complete' so the (currently zero) existing rows keep their meaning, and the
-- response columns become nullable ONLY for pending rows — a CHECK keeps a complete row from ever
-- carrying a null response, so the shape the port reads back cannot drift from the shape it wrote.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'idempotency_state') THEN
    CREATE TYPE idempotency_state AS ENUM ('pending', 'complete');
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "idempotency_key"
  ADD COLUMN IF NOT EXISTS "state" idempotency_state NOT NULL DEFAULT 'complete';--> statement-breakpoint

ALTER TABLE "idempotency_key" ALTER COLUMN "response_status" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_key" ALTER COLUMN "response_body" DROP NOT NULL;--> statement-breakpoint

-- A complete row MUST carry its cached response; a pending row must not pretend to have one.
ALTER TABLE "idempotency_key" DROP CONSTRAINT IF EXISTS "idempotency_key_complete_has_response";--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_complete_has_response" CHECK (
  ("state" = 'complete' AND "response_status" IS NOT NULL AND "response_body" IS NOT NULL)
  OR ("state" = 'pending' AND "response_status" IS NULL AND "response_body" IS NULL)
);--> statement-breakpoint

COMMENT ON COLUMN "idempotency_key"."state" IS
  'pending = a first request claimed this (org, key) and is still running; complete = its response is cached for replay. The unique index on (organization_id, key) is what makes the claim atomic.';
