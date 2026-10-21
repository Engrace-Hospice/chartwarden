-- GAP-020 -- catalogue the two M5 wristband permission keys in the `permission` mirror and grant them.
--
--   patient.wristband.issue  <- every role that already holds patient.edit   (print / reprint a band)
--   patient.wristband.void   <- every role that already holds patient.merge  (kill a band: identity error,
--                                                                             compromise; also needs step-up)
--
-- The keys live in @chartwarden/auth (M5_CONTRIBUTED_PERMISSIONS). `permission` is the FK target of
-- `role_permission.permission_key` and nothing in the deploy path syncs it, so without these rows no
-- administrator could grant the keys (the 0348/0382 lesson). Printing a band is a chart-maintenance act, so
-- whoever may edit the chart may print one; voiding is rarer and compliance-flavoured, so it follows the
-- merge permission. Idempotent (`ON CONFLICT DO NOTHING`); never removes a grant.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('patient.wristband.issue', 'patient_wristband', 'issue', 'clinical', 'caseload_or_scope', ''),
  ('patient.wristband.void', 'patient_wristband', 'void', 'compliance', 'caseload_or_scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", m.new_key
  FROM "role_permission" rp
  JOIN (VALUES
    ('patient.edit', 'patient.wristband.issue'),
    ('patient.merge', 'patient.wristband.void')
  ) AS m(old_key, new_key) ON m.old_key = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
