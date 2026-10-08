-- GAP-017 -- backstop for the verbal-order signature clock (42 CFR 418.104(b)): `verbal_order.deadline_at`
-- is derived from `received_at`, which the clinician supplies. The services now bound it against server time
-- (assertVerbalReceivedAtPlausible); this trigger is the schema-level floor under that, so a path that
-- skips the service (a new consumer, a script) still cannot start the clock in the future and postpone the
-- expiry worker. Only the FUTURE bound lives here: a past `received_at` is legitimate for a night order
-- recorded the next morning and for the expiry fixtures that backdate rows, and the look-back is a policy
-- the service owns. A BEFORE INSERT trigger, not a CHECK, so it never re-evaluates (and so never blocks)
-- the later status transitions on an existing row.
CREATE OR REPLACE FUNCTION verbal_order_received_at_not_future() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.received_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'VERBAL_RECEIVED_AT_IN_FUTURE: received_at % is more than 5 minutes ahead of the server clock', NEW.received_at;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "verbal_order_received_at_not_future_trg"
  BEFORE INSERT ON verbal_order
  FOR EACH ROW EXECUTE FUNCTION verbal_order_received_at_not_future();
