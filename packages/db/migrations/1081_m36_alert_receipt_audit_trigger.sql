-- M36 WP 1.8 (SG-03): alert_receipt (0243) shipped with RLS + grants (0247) but no write-audit trigger, the one
-- M36 table without one. A receipt row is "who read which alert, when": ids and a timestamp, no free text and no
-- PHI, so the generic trigger (the same one its sibling notification_delivery carries since 0017) is the right
-- fit - no scrub list. The table has no organization_id; the trigger takes the org from app.org_id, which every
-- write path (withOrgContext) sets.
CREATE TRIGGER "alert_receipt_audit" AFTER INSERT OR UPDATE OR DELETE ON alert_receipt
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
