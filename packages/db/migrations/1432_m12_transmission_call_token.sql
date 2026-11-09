-- compat: expand
-- M12 - a nonce for the transmit worker's vendor call (review of d333d1d9d..HEAD, LOW).
--
-- After the fence the worker owns its call by what it stamped on the transmission row. That used to be `transmission_started_at`, an application
-- clock value: two cycles that stamp the same instant (a test with a fixed clock, a clock that stepped back) were indistinguishable, so a worker
-- overtaken by a new claim could write over it. `call_token` is a random uuid the fence writes together with the stamp, and the worker's settle,
-- its created-prescription id write and its pre-send check must find it unchanged; whatever clears the stamp (a requeue after an outage or a failure)
-- clears the token. Expand-only: one nullable column with no default (a NULL token means no call is in progress), written only by the worker,
-- read by nothing else. Existing rows and old code are unaffected; table-level grants, RLS and the audit trigger already cover it.
ALTER TABLE "medication_order_transmission" ADD COLUMN IF NOT EXISTS "call_token" uuid;
