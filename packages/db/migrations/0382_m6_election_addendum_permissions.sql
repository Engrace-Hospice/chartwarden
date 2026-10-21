-- M6 — catalogue the three election-addendum permission keys (FY2027, 42 CFR 418.24(c)) in the `permission` mirror and
-- grant each to every role that already holds its election-statement counterpart.
--
--   election_addendum.read         ← roles holding election.read   (GET current + history)
--   election_addendum.write        ← roles holding election.draft  (draft, edit items, furnish)
--   election_addendum.acknowledge  ← roles holding election.sign   (record signature / refusal / not-required)
--
-- The keys live in @wardenx/auth (M6_CONTRIBUTED_PERMISSIONS). `permission` is the FK target of
-- `role_permission.permission_key` and nothing in the deploy path syncs it (`db:sync:permissions` is local-dev), so
-- without these rows no administrator could grant the keys (the 0348 lesson). The grants follow the 0316 precedent:
-- the addendum is the election statement's own required attachment (418.24(b)(6)), so whoever a tenant lets work the
-- election statement works the addendum, and nobody gains anything they could not already do on the statement.
-- Idempotent (`ON CONFLICT DO NOTHING`); never removes a grant.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('election_addendum.read', 'election_addendum', 'read', 'clinical', 'admission.scope', ''),
  ('election_addendum.write', 'election_addendum', 'write', 'clinical', 'admission.scope', ''),
  ('election_addendum.acknowledge', 'election_addendum', 'acknowledge', 'clinical', 'admission.scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", m.new_key
  FROM "role_permission" rp
  JOIN (VALUES
    ('election.read', 'election_addendum.read'),
    ('election.draft', 'election_addendum.write'),
    ('election.sign', 'election_addendum.acknowledge')
  ) AS m(old_key, new_key) ON m.old_key = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
