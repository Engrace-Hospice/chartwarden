-- compat: contract
-- M35 tenant pricing — a statement's organization, subscription and plan are one immutable ownership tuple.
-- The platform billing carrier bypasses tenant RLS by design. Foreign keys prove that the subscription and plan exist, but did not prove
-- that either belongs to the organization stamped on the statement (or that the plan is the subscription's plan). A malformed carrier
-- write could therefore put another tenant's billing inputs behind the wrong tenant's RLS boundary. The trigger now checks the tuple on
-- INSERT and refuses any later ownership rewrite while retaining the final-row and one-way Stripe-push rules from migration 1464.
-- Declared `contract`: writes that previously could create or restamp an inconsistent ownership tuple are now rejected.
CREATE OR REPLACE FUNCTION subscription_statement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'final' THEN
      RAISE EXCEPTION 'subscription_statement: a final statement cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM subscription s
     WHERE s.id = NEW.subscription_id
       AND s.organization_id = NEW.organization_id
       AND s.plan_id = NEW.plan_id
  ) THEN
    RAISE EXCEPTION 'subscription_statement: it must name the subscription''s own plan and organization'
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_statement_ownership_guard';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (NEW.organization_id, NEW.subscription_id, NEW.plan_id)
         IS DISTINCT FROM (OLD.organization_id, OLD.subscription_id, OLD.plan_id) THEN
    RAISE EXCEPTION 'subscription_statement: organization, subscription and plan cannot change'
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_statement_ownership_guard';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'final'
     AND (to_jsonb(NEW) - 'stripe_usage_record_id' - 'stripe_posted_at' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'stripe_usage_record_id' - 'stripe_posted_at' - 'updated_at') THEN
    RAISE EXCEPTION 'subscription_statement: a final statement cannot change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'final'
     AND ((OLD.stripe_usage_record_id IS NOT NULL AND NEW.stripe_usage_record_id IS DISTINCT FROM OLD.stripe_usage_record_id)
          OR (OLD.stripe_posted_at IS NOT NULL AND NEW.stripe_posted_at IS DISTINCT FROM OLD.stripe_posted_at)) THEN
    RAISE EXCEPTION 'subscription_statement: the Stripe push record of a final statement cannot be cleared or rewritten once recorded'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "subscription_statement_guard" ON "subscription_statement";--> statement-breakpoint
CREATE TRIGGER "subscription_statement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "subscription_statement"
  FOR EACH ROW EXECUTE FUNCTION subscription_statement_guard();
