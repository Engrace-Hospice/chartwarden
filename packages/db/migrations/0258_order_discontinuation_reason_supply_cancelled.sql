-- F-166 (#248) — the m11 `handlers-unbound` group's `m21.supply_request.cancelled` consumer. M11's own
-- discharge cascade (F-102) already discontinues its order SYNCHRONOUSLY before it ever emits
-- `m11.order.supply_cancellation_requested`, so a redelivery of M21's reply always finds the order already
-- terminal. But `cancelSupplyRequest` (`21-supplies/routes/write-service-drizzle.ts`) is a SECOND, real
-- producer of this same catalogued event — a staff member cancelling the supply/DME/comfort-kit request
-- directly at M21, never through M11's cascade — and on THAT path the M11 order is still in flight and
-- genuinely needs releasing. `order_discontinuation_reason` had no value for it: every existing member
-- names either a clinical decision or a system cascade M11 itself originates, and none of them honestly
-- describes "the downstream fulfillment was cancelled out from under this order."
ALTER TYPE "public"."order_discontinuation_reason" ADD VALUE IF NOT EXISTS 'supply_request_cancelled';
