-- F-198 (#248) — M11: bounded AUTO-RETRY state for lab orders whose ORM never reached M29, and the index the
-- stuck-order sweeps and the held-order worklist read through.
--
-- WHY STATE ON THE ORDER. F-182's resend, F-187's `dispatch_refused:*` and F-188's recovery all end the same way for an
-- order refused because a CONFIGURATION cause (a lapsed BAA, an unlinked feed, an incomplete MSH identity, an unconfirmed
-- physician NPI) was outside the order: it sits `failed` until a human notices the cause was fixed and presses resend.
-- No outbound row exists for any of these, so an automatic retry cannot duplicate — but an unbounded one would loop
-- against a permanently broken configuration and re-alert the ordering provider on every round trip (the applier raises
-- `transmission_terminal_failed` each time a refusal flips an order `failed`). A retry needs a BOUND, and a bound needs a
-- counter that survives the sweep, so it lives beside the failure it describes:
--   transmission_auto_retry_count         how many times the sweep RE-EMITTED the request for this order (only an actual
--                                         re-emission counts; a check that finds the cause still present costs nothing)
--   transmission_auto_retry_at            when the sweep last re-emitted — the backoff clock
--   transmission_auto_retry_exhausted_at  when the sweep gave up (attempts or window used up) and raised its ONE
--                                         "an operator must act now" alert — set once, so the alert cannot repeat
-- All three are additive; existing rows read as "never auto-retried" (0 / NULL / NULL).
--
-- THE INDEX. `idx_order_transmission_status` covers only `pending`/`pending_retry`. The sweeps and the
-- worklist scan the OTHER end — `failed` lab orders, oldest first — which had no index and fell back to
-- `order_record_kind_status_idx` (org, kind, order status) plus a filter over every active lab order of the tenant. It is
-- partial, so it holds only the rows that are actually stuck (a handful per tenant), and it is keyed
-- (organization_id, updated_at, id): `updated_at` is when the applier marked the order failed, i.e. the age the worklist
-- sorts and the escalation measures, and `id` makes the keyset cursor total.
--
-- `order_record` is PARTITIONED BY RANGE (created_at): the ALTER and the CHECK propagate to every leaf and the index is
-- created on the parent (the 0131 / 0266 precedent). RLS, FORCE and the M4 write-audit trigger already cover the table.
ALTER TABLE "order_record"
  ADD COLUMN IF NOT EXISTS "transmission_auto_retry_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "transmission_auto_retry_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "transmission_auto_retry_exhausted_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "order_record"
  ADD CONSTRAINT "order_record_auto_retry_count_chk" CHECK ("transmission_auto_retry_count" >= 0);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_order_transmission_failed"
  ON "order_record" ("organization_id", "updated_at", "id")
  WHERE "kind" = 'lab' AND "transmission_status" = 'failed';
