-- M36 WP 6.7 (ADR-0099, PROPOSED), slice S1b - the ONE definition of "may this person reach the family thread right now" (D2, D10, D12, D15), as SQL
-- functions. M5, M16 and M39 own the tables it reads; M36 application code may not name them (arch:tables), so the neighbouring facts are read here, in
-- the database, and the application calls these functions inside the very statement that resolves the bearer. Every function is SECURITY INVOKER and
-- STABLE: it runs under the caller's own org RLS (and also compares organization_id to app.org_id), so it can never read another tenant, and it judges
-- every instant on the database clock (now(), current_date). No grant, no cache.
--   message_family_person(pc)    one row: patient, caregiver, relationship, tenancy ids, the eligibility reason, the mode and the language
--   message_family_caregivers(p) the caregiver ids of a patient, primary first (the invite picker)
--   message_family_counsellor    is this user the assigned counsellor of the patient's open bereavement plan (D15: the staff side after a death)
-- The reason is the FIRST cause that applies: blocked, involvement (not started / ended), Part 2 (sud flag, a snapshot being recomputed, or NO snapshot at all: fail closed), then for a
-- living patient (active / on hold) an ACTIVE family_caregiver_access consent that names this caregiver with a messaging scope, or for a deceased patient
-- membership of the OPEN bereavement plan inside its 13 month window plus a surviving consent. The legal-representative (DPOA) route is deliberately NOT
-- honoured: nothing here proves the DPOA consent names THIS caregiver, so it fails closed.

CREATE OR REPLACE FUNCTION message_family_person(p_pc uuid)
RETURNS TABLE (
  patient_id uuid, patient_caregiver_id uuid, patient_name text, caregiver_name text, relationship text,
  is_legal_representative boolean, provider_entity_id uuid, location_id uuid, reason text, mode text, language text
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pt.id, pc.id, btrim(pt.legal_first_name || ' ' || pt.legal_last_name), btrim(cg.first_name || ' ' || cg.last_name),
         pc.relationship::text, pc.is_legal_representative, pc.provider_entity_id, pc.location_id,
         (CASE
            WHEN c.blocked_at IS NOT NULL THEN 'blocked'
            WHEN pc.involvement_from > current_date OR (pc.involvement_to IS NOT NULL AND pc.involvement_to < current_date) THEN 'involvement_ended'
            WHEN NOT EXISTS (
              SELECT 1 FROM patient_privacy_flag_snapshot f
               WHERE f.organization_id = pc.organization_id AND f.patient_id = pc.patient_id
                 AND f.invalidated_at IS NULL AND NOT ('sud' = ANY(f.flags))) THEN 'part2_restricted'
            WHEN pt.status::text IN ('active', 'on_hold') THEN
              CASE WHEN EXISTS (
                SELECT 1 FROM delegated_access da
                  JOIN consent_record cr ON cr.organization_id = da.organization_id AND cr.id = da.consent_record_id
                                        AND cr.organization_id = pc.organization_id AND cr.patient_id = pc.patient_id
                 WHERE da.organization_id = pc.organization_id AND da.patient_id = pc.patient_id AND da.delegate_caregiver_id = pc.caregiver_id
                   AND da.revoked_at IS NULL AND da.effective_from <= now() AND (da.effective_until IS NULL OR da.effective_until > now())
                   AND da.scope_kind::text IN ('view_and_message', 'view_message_and_decisions')
                   AND cr.type_key::text = 'family_caregiver_access' AND cr.status::text = 'active' AND cr.revoked_at IS NULL
                   AND cr.effective_at <= now() AND (cr.expires_at IS NULL OR cr.expires_at > now())
              ) THEN 'ok' ELSE 'no_consent' END
            WHEN pt.status::text = 'deceased' THEN
              CASE
                WHEN NOT EXISTS (
                  SELECT 1 FROM bereaved_contact bc
                    JOIN bereavement_plan bp ON bp.organization_id = bc.organization_id AND bp.id = bc.plan_id
                   WHERE bc.organization_id = pc.organization_id AND bc.patient_caregiver_id_from_m5 = pc.id AND bp.patient_id = pc.patient_id
                     AND bc.status::text = 'active' AND bp.status::text IN ('active', 'paused')
                     AND bp.death_date + make_interval(months => 13) > now()
                ) THEN 'not_in_bereavement_plan'
                WHEN EXISTS (
                  SELECT 1 FROM delegated_access da
                    JOIN consent_record cr ON cr.organization_id = da.organization_id AND cr.id = da.consent_record_id
                                          AND cr.organization_id = pc.organization_id AND cr.patient_id = pc.patient_id
                   WHERE da.organization_id = pc.organization_id AND da.patient_id = pc.patient_id AND da.delegate_caregiver_id = pc.caregiver_id
                     AND da.revoked_at IS NULL AND da.effective_from <= now() AND (da.effective_until IS NULL OR da.effective_until > now())
                     AND da.scope_kind::text IN ('view_and_message', 'view_message_and_decisions')
                     AND cr.type_key::text = 'family_caregiver_access' AND cr.status::text = 'active' AND cr.revoked_at IS NULL
                     AND cr.effective_at <= now() AND (cr.expires_at IS NULL OR cr.expires_at > now()) AND cr.survives_death = true
                ) OR EXISTS (
                  SELECT 1 FROM bereaved_contact bc
                    JOIN consent_record cr ON cr.organization_id = bc.organization_id AND cr.id = bc.consent_record_id
                   WHERE bc.organization_id = pc.organization_id AND bc.patient_caregiver_id_from_m5 = pc.id AND bc.status::text = 'active'
                     AND cr.patient_id = pc.patient_id AND cr.type_key::text IN ('bereavement_outreach_consent', 'personal_representative_authority_post_death')
                     AND cr.status::text = 'active' AND cr.revoked_at IS NULL
                     AND cr.effective_at <= now() AND (cr.expires_at IS NULL OR cr.expires_at > now())
                ) THEN 'ok'
                ELSE 'no_consent'
              END
            ELSE 'patient_status'
          END),
         (CASE WHEN pt.status::text = 'deceased' THEN 'bereavement' ELSE 'standard' END),
         COALESCE(NULLIF(btrim(cg.preferred_language_code), ''), NULLIF(btrim(pref.preferred_language_code), ''))
    FROM patient_caregiver pc
    JOIN patient pt ON pt.organization_id = pc.organization_id AND pt.id = pc.patient_id
    JOIN caregiver cg ON cg.organization_id = pc.organization_id AND cg.id = pc.caregiver_id
    LEFT JOIN patient_communication_preference pref ON pref.organization_id = pc.organization_id AND pref.patient_id = pc.patient_id
    LEFT JOIN message_family_contact c ON c.organization_id = pc.organization_id AND c.patient_caregiver_id = pc.id
   WHERE pc.id = p_pc AND pc.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_family_caregivers(p_patient uuid)
RETURNS TABLE (patient_caregiver_id uuid, ord bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pc.id, row_number() OVER (ORDER BY pc.is_primary DESC, pc.created_at ASC, pc.id ASC)
    FROM patient_caregiver pc
   WHERE pc.patient_id = p_patient AND pc.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
   ORDER BY 2 LIMIT 50
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_family_counsellor(p_patient uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM bereavement_plan bp
      JOIN membership m ON m.id = bp.assigned_counselor_user_id AND m.organization_id = bp.organization_id
     WHERE bp.organization_id = nullif(current_setting('app.org_id', true), '')::uuid AND bp.patient_id = p_patient
       AND bp.status::text IN ('active', 'paused') AND m.user_id = p_user AND m.status::text = 'active')
$$;
