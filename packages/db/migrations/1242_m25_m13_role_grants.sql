-- M25 milestone 13a permissions: grant the beneficiary-appeal and representative keys to the roles that already hold the
-- matching existing key, in every tenant that has them. 1240 added the catalog rows only and the template materializer runs
-- at tenant creation, so an EXISTING tenant's roles would hold none of them (the gap 1111, 1173, 1176, 1191 and 1209 each
-- closed for their own keys).
--
--   appeal.read       -> beneficiary_appeal.read, representative.read
--   appeal.create     -> beneficiary_appeal.manage, representative.manage   (record the appeal, draft the appointment)
--   mac_rule.manage   -> representative.verify, representative_form.configure, representative.read
--                        (activating an appointment and entering the organization's own form versions are billing-lead /
--                        compliance decisions, like the MAC and payer-path rule data; the recorder and the activator of one
--                        appointment are kept apart by the appointment's own CHECK and trigger, not by the role)
--
-- The ABAC override is NOT copied (an override names a predicate written for appeal cases). A tenant tightens by removing a
-- grant from a role it owns; a role with none of the source keys is unchanged. No external_auditor role holds these. Idempotent.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", m."new_key"
  FROM "role_permission" rp
  JOIN (VALUES
    ('appeal.read', 'beneficiary_appeal.read'),
    ('appeal.read', 'representative.read'),
    ('appeal.create', 'beneficiary_appeal.manage'),
    ('appeal.create', 'representative.manage'),
    ('mac_rule.manage', 'representative.read'),
    ('mac_rule.manage', 'representative.verify'),
    ('mac_rule.manage', 'representative_form.configure')
  ) AS m ("source_key", "new_key") ON m."source_key" = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
