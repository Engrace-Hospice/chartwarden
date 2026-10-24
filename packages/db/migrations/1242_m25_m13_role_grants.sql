-- M25 milestone 13a permissions: grant the beneficiary-appeal and representative keys to existing tenants' roles. 1240 added the
-- catalog rows only and the template materializer runs at tenant creation, so an EXISTING tenant's roles would hold none of them
-- (the gap 1111, 1173, 1176, 1191 and 1209 each closed for their own keys).
--
--   appeal.read     -> beneficiary_appeal.read, representative.read
--   appeal.create   -> beneficiary_appeal.manage, representative.manage   (record the appeal, draft the appointment)
--
-- Activating an appointment (representative.verify) and entering the organization's form versions (representative_form.configure)
-- are NOT granted by key inheritance: a billing lead who edits MAC rules is not thereby the second person who attests a
-- beneficiary's representative. They are granted only to the existing compliance/administration roles named below (the M9
-- precedent); a tenant opts further roles in by granting the key itself. Full-catalog roles (administrator, org_admin) also get
-- them from the template materializer. The ABAC override is NOT copied. No external_auditor role holds any of these. Idempotent.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", m."new_key"
  FROM "role_permission" rp
  JOIN (VALUES
    ('appeal.read', 'beneficiary_appeal.read'),
    ('appeal.read', 'representative.read'),
    ('appeal.create', 'beneficiary_appeal.manage'),
    ('appeal.create', 'representative.manage')
  ) AS m ("source_key", "new_key") ON m."source_key" = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
 CROSS JOIN (VALUES ('representative.read'), ('representative.verify'), ('representative_form.configure')) AS k ("key")
 WHERE r."key" IN ('administrator', 'org_admin', 'compliance_officer')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
