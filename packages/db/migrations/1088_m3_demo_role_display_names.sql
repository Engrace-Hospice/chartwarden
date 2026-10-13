-- Repair only the known bad rows produced by scripts/db/seed-staff-personas.ts in the fixed demo
-- organization. The current-name predicate preserves any tenant/user customization. This changes
-- display text only: role ids, keys, grants, membership assignments and permissions are untouched.
UPDATE role AS r
SET name = corrected.new_name
FROM organization AS o
JOIN (VALUES
  ('rn'::text,                'RN Case Manager'::text,          'Registered Nurse (RN)'::text),
  ('md'::text,                'Hospice Medical Director'::text, 'Physician (MD/DO)'::text),
  ('hospice_physician'::text, 'Hospice Medical Director'::text, 'Hospice Physician'::text),
  ('compliance_officer'::text,'Clinical Supervisor'::text,      'Compliance Officer'::text)
) AS corrected(role_key, old_name, new_name) ON true
WHERE o.slug = 'wardenx-demo'
  AND r.organization_id = o.id
  AND r.key = corrected.role_key
  AND r.name = corrected.old_name;
