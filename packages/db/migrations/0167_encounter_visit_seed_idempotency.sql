-- M8's m17.visit.published consumer creates at most one encounter per source visit. Existing
-- duplicate rows indicate prior data corruption and must be reconciled instead of silently picked.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM encounter
    WHERE visit_id IS NOT NULL
    GROUP BY organization_id, visit_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'cannot enforce encounter visit idempotency: duplicate (organization_id, visit_id) rows exist';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "encounter_org_visit_unique"
  ON "encounter" ("organization_id", "visit_id")
  WHERE "visit_id" IS NOT NULL;--> statement-breakpoint
-- Scheduled visits may be published before their service date. Draft creation is allowed then; the
-- application still rejects future service dates on user-authored ad-hoc encounters and at finalize.
ALTER TABLE "encounter" DROP CONSTRAINT IF EXISTS "encounter_service_date_not_future";
