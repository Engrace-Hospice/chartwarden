-- M25 milestone 12a-1 permissions: grant the payer-appeal keys to the roles that already hold the matching existing key, in
-- every tenant that has them. 1206 added the catalog rows only and the template materializer runs at tenant creation, so
-- an EXISTING tenant's roles would hold none of them (the gap 1111, 1173, 1176 and 1191 each closed for their own keys).
--
--   appeal.read       -> payer_appeal.read, payer_appeal_path.read
--   appeal.create     -> payer_appeal.manage   (open a level, record the notice date, move it, record the decision)
--   mac_rule.manage   -> payer_appeal_path.manage, payer_appeal_path.verify
--                        (editing the organization's rule data is a billing-lead decision, like the MAC rules; the author
--                        and the verifier of one path are kept apart by the path's own CHECK, not by the role)
--
-- The ABAC override is NOT copied (an override names a predicate written for appeal cases). A tenant tightens by removing a
-- grant from a role it owns; a role with none of the source keys is unchanged. No external_auditor role holds these. Idempotent.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", m."new_key"
  FROM "role_permission" rp
  JOIN (VALUES
    ('appeal.read', 'payer_appeal.read'),
    ('appeal.read', 'payer_appeal_path.read'),
    ('appeal.create', 'payer_appeal.manage'),
    ('mac_rule.manage', 'payer_appeal_path.manage'),
    ('mac_rule.manage', 'payer_appeal_path.verify')
  ) AS m ("source_key", "new_key") ON m."source_key" = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
