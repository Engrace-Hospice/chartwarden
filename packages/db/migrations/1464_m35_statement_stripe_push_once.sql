-- compat: contract
-- M35 (slice 2) - a final statement's Stripe push record can be WRITTEN once and never cleared or rewritten (tightens the 1412 guard).
-- 1412 froze a final statement but left `stripe_usage_record_id` and `stripe_posted_at` writable, because pushing the statement is
-- something that happens AFTER it closes. The platform carrier holds UPDATE on the whole table, so those two columns also let it clear
-- `stripe_posted_at` and put a posted statement back into the set that still has to be pushed: a duplicate charge the moment the Stripe
-- port is bound (it is not bound today). The push is a single NULL -> value transition on each column; the guard now refuses anything
-- else on a final statement: a clear, or a rewrite of a value already recorded. A NULL -> value write (the push itself, and a retry of a
-- push that recorded one column only) and a draft statement are unaffected, as is every other column's freeze.
-- Declared `contract`: a write the previous release's trigger allowed (clearing or replacing a recorded push) is now refused. No row
-- is touched, and the previous release only ever wrote these columns from NULL.
CREATE OR REPLACE FUNCTION subscription_statement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'final' THEN
      RAISE EXCEPTION 'subscription_statement: a final statement cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'final'
     AND (to_jsonb(NEW) - 'stripe_usage_record_id' - 'stripe_posted_at' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'stripe_usage_record_id' - 'stripe_posted_at' - 'updated_at') THEN
    RAISE EXCEPTION 'subscription_statement: a final statement cannot change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'final'
     AND ((OLD.stripe_usage_record_id IS NOT NULL AND NEW.stripe_usage_record_id IS DISTINCT FROM OLD.stripe_usage_record_id)
          OR (OLD.stripe_posted_at IS NOT NULL AND NEW.stripe_posted_at IS DISTINCT FROM OLD.stripe_posted_at)) THEN
    RAISE EXCEPTION 'subscription_statement: the Stripe push record of a final statement cannot be cleared or rewritten once recorded'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
