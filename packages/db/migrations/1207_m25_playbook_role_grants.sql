-- M25 milestone 9a-1 permissions: grant the playbook keys in every tenant that has the matching role or key. 1206 added the
-- catalog rows only and the template materializer runs at tenant creation, so an EXISTING tenant's roles would hold none of
-- them (the gap 1111, 1119 and 1191 each closed for their own keys).
--
-- A playbook is guidance beside a denial and is written and approved by the billing lead, so the grant mirrors the keys that
-- already say who works denials and who decides appeals instead of naming roles:
--   denial.read, appeal.decide -> playbook.read        appeal.decide -> playbook.author, playbook.publish
-- Publishing needs a person other than the author (enforced in the service and by a CHECK), so a tenant with one
-- appeal.decide holder cannot publish until it names a second reviewer. The compliance officer reviews guidance but does not
-- work denials, so that role is granted playbook.read and playbook.publish by role key (new tenants: templates.ts).
-- No ABAC override is copied: an override names a predicate written for denial rows, and the playbook is organization content.
-- A tenant tightens by removing a grant from a role it owns; a role with none of the source keys is unchanged. Idempotent.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", m."new_key"
  FROM "role_permission" rp
  JOIN (VALUES
    ('denial.read', 'playbook.read'),
    ('appeal.decide', 'playbook.read'),
    ('appeal.decide', 'playbook.author'),
    ('appeal.decide', 'playbook.publish')
  ) AS m ("source_key", "new_key") ON m."source_key" = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
 CROSS JOIN (VALUES ('playbook.read'), ('playbook.publish')) AS k ("key")
 WHERE r."key" = 'compliance_officer'
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
