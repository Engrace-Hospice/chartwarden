-- M1 Foundation §3.10 — a COMPLETE idempotency record may have no response BODY (F-073, #182).
--
-- `0121` relaxed `response_status` / `response_body` to nullable so a `pending` row could exist, and
-- guarded the relaxation with a CHECK requiring a complete row to carry BOTH. That considered exactly
-- two shapes — "claimed, still running" and "finished with a JSON body" — and missed the third the
-- platform actually serves: a response with NO body at all.
--
-- 24 routes answer `code(204)`, and `packages/ui/src/core/api/client.ts` attaches an
-- `Idempotency-Key` to EVERY mutating request (POST/PUT/PATCH/DELETE alike), so all 24 ran the
-- completion path. `onSend` recorded `body: undefined`, Drizzle omitted the column from the UPDATE,
-- and the CHECK raised 23514 — AFTER the handler had already committed. The client got a 500 for a
-- write that succeeded, and the key was left `pending`, which answers 409 to every retry for its
-- whole 24h TTL. Proven on a live stack: the row was gone from `document_tag` while the UI said the
-- action could not be completed.
--
-- Nothing caught it because `createInMemoryIdempotencyStore` — the slice and test default — is a Map
-- with no constraint, so the two stores disagree only under Postgres. Across 141 `complete` rows in a
-- fully-seeded database the recorded statuses are 200, 201, 202 and 503; not one 204 has ever been
-- written by the seed, which drives these routes through the real API.
--
-- WHAT THE CONSTRAINT IS FOR, restated: a complete row must carry the response it will REPLAY. A 204
-- has no body, and that is its response — requiring one asserts something untrue about HTTP. The
-- status is the part that must always be there, and it still is. A pending row must still carry
-- neither, so "claimed but not finished" remains impossible to confuse with "finished".

ALTER TABLE "idempotency_key" DROP CONSTRAINT IF EXISTS "idempotency_key_complete_has_response";--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_complete_has_response" CHECK (
  ("state" = 'complete' AND "response_status" IS NOT NULL)
  OR ("state" = 'pending' AND "response_status" IS NULL AND "response_body" IS NULL)
);--> statement-breakpoint

COMMENT ON CONSTRAINT "idempotency_key_complete_has_response" ON "idempotency_key" IS
  'A complete record must carry the STATUS it replays; the body may be NULL because a 204 (and any other bodiless response) has none. A pending record must carry neither. F-073 (#182).';
