// M36 WP 6.7 (ADR-0099 D2, D10, D12, D15) - the ONE definition of "may this person reach the family thread right now". It is a SQL expression, not a
// cached grant: every contact request embeds it in the same statement that resolves the bearer, on the database clock, so a withdrawn consent, an
// ended involvement, a Part 2 restriction, a block, a discharge or a death outside the bereavement plan ends access on the very next request. The
// staff screens embed the same expression to show a reason code, so what staff are told and what the contact is allowed can never disagree.
//
// M36 reads the neighbouring modules' rows through raw SQL on purpose (no schema import, no seam call): a seam call would be a second round trip
// between the eligibility decision and the read it protects. The tables are named here and nowhere else. Every one is RLS-scoped, so the app.org_id
// of the transaction is also a tenant boundary on every join.
//
// FAIL CLOSED: a missing patient, caregiver or consent row is "not eligible"; a patient whose privacy-flag snapshot is invalidated (the flags are
// being recomputed) or carries the `sud` flag is Part 2 restricted. This build has no Part 2 release that names a family contact, so a restricted
// patient has no family thread at all (ADR-0099 D10 default).
import { FAMILY_BEREAVEMENT_WINDOW_MONTHS } from "@chartwarden/types";
import { type SQL, sql } from "drizzle-orm";

/** Statuses of a patient whose consenting contact may message (D12): everything else is `patient_status`, except death (D15). */
const LIVE_PATIENT_STATUSES = ["active", "on_hold"] as const;

const delegatedConsent = (survivesDeath: boolean): SQL => sql`EXISTS (
  SELECT 1 FROM delegated_access da
    JOIN consent_record cr ON cr.organization_id = da.organization_id AND cr.id = da.consent_record_id
   WHERE da.organization_id = pc.organization_id AND da.patient_id = pc.patient_id AND da.delegate_caregiver_id = pc.caregiver_id
     AND da.revoked_at IS NULL AND da.effective_from <= now() AND (da.effective_until IS NULL OR da.effective_until > now())
     AND da.scope_kind::text IN ('view_and_message', 'view_message_and_decisions')
     AND cr.type_key::text = 'family_caregiver_access' AND cr.status::text = 'active' AND cr.revoked_at IS NULL
     AND cr.effective_at <= now() AND (cr.expires_at IS NULL OR cr.expires_at > now())
     ${survivesDeath ? sql`AND cr.survives_death = true` : sql``})`;

const representativeConsent = sql`(pc.is_legal_representative = true AND pc.lr_authority::text = 'dpoa_healthcare' AND pc.lr_proof_doc_ref IS NOT NULL AND EXISTS (
  SELECT 1 FROM consent_record cr
   WHERE cr.organization_id = pc.organization_id AND cr.patient_id = pc.patient_id
     AND cr.type_key::text = 'dpoa_healthcare' AND cr.status::text = 'active' AND cr.revoked_at IS NULL
     AND cr.effective_at <= now() AND (cr.expires_at IS NULL OR cr.expires_at > now())))`;

const bereavementPlanMember = sql`EXISTS (
  SELECT 1 FROM bereaved_contact bc
    JOIN bereavement_plan bp ON bp.organization_id = bc.organization_id AND bp.id = bc.plan_id
   WHERE bc.organization_id = pc.organization_id AND bc.patient_caregiver_id_from_m5 = pc.id AND bp.patient_id = pc.patient_id
     AND bc.status::text = 'active' AND bp.status::text IN ('active', 'paused')
     AND bp.death_date + make_interval(months => ${FAMILY_BEREAVEMENT_WINDOW_MONTHS}) > now())`;

const bereavementConsent = sql`(${delegatedConsent(true)} OR EXISTS (
  SELECT 1 FROM bereaved_contact bc
    JOIN consent_record cr ON cr.organization_id = bc.organization_id AND cr.id = bc.consent_record_id
   WHERE bc.organization_id = pc.organization_id AND bc.patient_caregiver_id_from_m5 = pc.id
     AND cr.patient_id = pc.patient_id AND cr.status::text = 'active' AND cr.revoked_at IS NULL
     AND cr.effective_at <= now() AND (cr.expires_at IS NULL OR cr.expires_at > now())))`;

const part2Restricted = sql`EXISTS (
  SELECT 1 FROM patient_privacy_flag_snapshot f
   WHERE f.organization_id = pc.organization_id AND f.patient_id = pc.patient_id
     AND ('sud' = ANY(f.flags) OR f.invalidated_at IS NOT NULL))`;

const livePatientList = sql.join(
  LIVE_PATIENT_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * `ok`, or the FIRST reason the person is not eligible. Aliases: pc = patient_caregiver, pt = patient, c = message_family_contact (LEFT JOINed: absent
 * before the first invitation). The order is the order a staff member can act on: a block first, then the facts about the person, then Part 2.
 */
export const eligibilityReason: SQL = sql`(CASE
  WHEN c.blocked_at IS NOT NULL THEN 'blocked'
  WHEN pc.involvement_to IS NOT NULL AND pc.involvement_to < current_date THEN 'involvement_ended'
  WHEN ${part2Restricted} THEN 'part2_restricted'
  WHEN pt.status::text IN (${livePatientList}) THEN
    CASE WHEN ${delegatedConsent(false)} OR ${representativeConsent} THEN 'ok' ELSE 'no_consent' END
  WHEN pt.status::text = 'deceased' THEN
    CASE WHEN NOT ${bereavementPlanMember} THEN 'not_in_bereavement_plan'
         WHEN ${bereavementConsent} THEN 'ok'
         ELSE 'no_consent' END
  ELSE 'patient_status'
END)`;

/** `bereavement` once the patient has died, else `standard`. Only meaningful where {@link eligibilityReason} is `ok`. */
export const eligibilityMode: SQL = sql`(CASE WHEN pt.status::text = 'deceased' THEN 'bereavement' ELSE 'standard' END)`;

/** The contact's preferred language: the caregiver's own, else the patient's communication preference. */
export const contactLanguage: SQL = sql`COALESCE(NULLIF(btrim(cg.preferred_language_code), ''), NULLIF(btrim(pref.preferred_language_code), ''))`;

/** The joins every consumer of the expression needs (the caller supplies WHERE; `c` is the optional contact row). */
export const eligibilityJoins: SQL = sql`
  patient_caregiver pc
  JOIN patient pt ON pt.organization_id = pc.organization_id AND pt.id = pc.patient_id
  JOIN caregiver cg ON cg.organization_id = pc.organization_id AND cg.id = pc.caregiver_id
  LEFT JOIN patient_communication_preference pref ON pref.organization_id = pc.organization_id AND pref.patient_id = pc.patient_id
  LEFT JOIN message_family_contact c ON c.organization_id = pc.organization_id AND c.patient_caregiver_id = pc.id`;
