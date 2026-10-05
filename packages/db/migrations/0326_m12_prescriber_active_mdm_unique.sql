-- M12 — one ACTIVE dosespot_prescriber row per external physician MDM id per tenant.
--
-- Before this, `external_physician_mdm_id` could be shared by two roster rows, so two users could both be
-- "the named prescriber" of a verbal order (the CMS no-proxy rule keys on that mapping). The partial unique
-- index lets a revoked row keep its historical MDM id (revoked_at IS NOT NULL is outside the predicate) and
-- allows any number of rows with no MDM id.
--
-- Existing duplicate data: this migration deliberately does NOT pick a winner, revoke, or null anything —
-- choosing which of two users is the real prescriber is a clinical-identity decision, not a schema one. If
-- any tenant already has two active rows on one MDM id it FAILS LOUDLY, listing the offenders, so an
-- operator can revoke the wrong row(s) and re-run. (Dev DB checked read-only: no duplicates.)
DO $$
DECLARE
  dup_count integer;
  dup_detail text;
BEGIN
  SELECT count(*), string_agg(format('org=%s mdm=%s rows=%s', organization_id, external_physician_mdm_id, n), '; ')
    INTO dup_count, dup_detail
    FROM (
      SELECT organization_id, external_physician_mdm_id, count(*) AS n
        FROM "dosespot_prescriber"
       WHERE external_physician_mdm_id IS NOT NULL AND revoked_at IS NULL
       GROUP BY organization_id, external_physician_mdm_id
      HAVING count(*) > 1
    ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'dosespot_prescriber has % (organization, external_physician_mdm_id) pair(s) with more than one ACTIVE roster row: %. Revoke the incorrect row(s) (set revoked_at) and re-run this migration.', dup_count, dup_detail;
  END IF;
END
$$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "dosespot_prescriber_active_mdm_unique"
  ON "dosespot_prescriber" ("organization_id", "external_physician_mdm_id")
  WHERE "external_physician_mdm_id" IS NOT NULL AND "revoked_at" IS NULL;
