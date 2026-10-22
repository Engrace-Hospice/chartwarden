-- M36 WP 5.6 (ADR-0086, PROPOSED) - the message destruction executor spends an APPROVED certificate's count without touching it.
--   * record_count is what the approver approved. It is IMMUTABLE once the certificate leaves `pending` (guard trigger): nothing, the executor
--     included, may rewrite the approved figure. (One carve-out: M4's own audit-class sweep records the actual erased count while it moves an
--     `audit.*` certificate out of `approved`; a `message.*` certificate has no carve-out.)
--   * Spending is tracked beside it: destroyed_count (committed deletions, only ever goes up) and reserved_count (planned but not yet settled).
--     The executor RESERVES a batch's planned count in its plan transaction (under a row lock on the certificate, so a second executor waits and
--     then sees the reduced remainder), deletes, then settles: reserved goes down by the plan, destroyed up by what was really deleted (the
--     difference is refunded). A crash after the reserve can only UNDER-delete, never over-delete. remaining = record_count - destroyed_count -
--     reserved_count, and a CHECK keeps destroyed + reserved within the approved count.
--   * The destruction credential may SELECT the certificate (org-pinned) so its delete transaction can re-check that the certificate is still
--     approved and fresh in the same transaction as the DELETE; it can write nothing here.
ALTER TABLE "destruction_certificate"
  ADD COLUMN "destroyed_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "reserved_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "destruction_certificate"
  ADD CONSTRAINT "destruction_certificate_spend_nonneg" CHECK ("destroyed_count" >= 0 AND "reserved_count" >= 0),
  ADD CONSTRAINT "destruction_certificate_spend_within_approved" CHECK ("destroyed_count" + "reserved_count" <= "record_count");--> statement-breakpoint

CREATE OR REPLACE FUNCTION destruction_certificate_count_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- M4's own audit sweep legitimately records the ACTUAL erased count on the approved -> executed/partial_refused/held transition of an `audit.*`
  -- certificate; that one transition stays allowed. A message.* certificate is frozen outright, and nothing else may change the figure.
  IF OLD.status <> 'pending' AND NEW.record_count IS DISTINCT FROM OLD.record_count
     AND (OLD.data_class LIKE 'message.%' OR NEW.status = OLD.status) THEN
    RAISE EXCEPTION 'destruction_certificate_count: the approved count cannot change once the certificate leaves pending' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.destroyed_count < OLD.destroyed_count THEN
    RAISE EXCEPTION 'destruction_certificate_count: destroyed_count only goes up' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_destruction_certificate_count_guard"
  BEFORE UPDATE ON "destruction_certificate"
  FOR EACH ROW EXECUTE FUNCTION destruction_certificate_count_guard();--> statement-breakpoint

GRANT SELECT ON "destruction_certificate" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "destruction_certificate_destruction_read" ON "destruction_certificate"
  FOR SELECT TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
