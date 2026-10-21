// apps/backend/src/modules/31-portal/write-paths/caregiver-attestation.ts — M31-T06 (§7.7 / M13 D10).
//
// The caregiver-attested medication administration write path. M13 OWNS the write: the
// `POST /administrations/caregiver-attested` route + the `recordCaregiverAttested` service + idempotency on
// `(patientId, medicationOrderId, administeredAt)` (§2.6). M31 owns the PORTAL-SIDE precondition gate: before
// M31 posts to M13 it proves the §7.7 step-2 facts — the order is still active, the dose time is within ±2h of
// now, the attestation checkbox is checked, and the caller is the primary caregiver or DPOA. Only when all
// hold does M31 hand M13 the validated payload; M13 re-validates (defense in depth) and creates the record
// with `source='caregiver_attested'`.
//
// This core is PURE (§9.1): injected facts + `nowMs` in, a validated payload or a `PortalWriteError` out. No
// I/O — the order-active fact, the caregiver-relationship fact, and the discharge-read-only fact are resolved
// by the caller (T07 route) through the upstream reader seams and passed in. The dose-time window and the
// attestation checkbox are the two facts M31 owns outright, checked here.
//
// EMIT: §7.7 step 5 names an `m31.caregiver_attestation.recorded` link event; the T01 outbox taxonomy
// (`M31_EVENT_NAMES`) does NOT carry it in the reduced 3-table scope (the attestation is M13's row, linked by
// the M13-issued administration id — M31 stores no attestation row of its own), so this core plans no M31
// outbox event. The M4 disclosure-accounting write (§7.7 step 6) is the route's `auditRead`/`audit` call, not
// a domain concern. If a future scope adds the link event, add it to `M31_EVENT_NAMES` first (the arch:gaps
// `mN.` convention is validated against that tuple).
import type { MembershipId, PatientId } from "@chartwarden/types";
import { requirePortalWrite } from "./errors";

/** §7.7 — the ±2h dose-time window (platform floor; a tenant may TIGHTEN, never loosen). */
export const CAREGIVER_ATTEST_WINDOW_MS = 2 * 60 * 60 * 1000;

/** The M5-designated relationships permitted to attest a dose into the chart (§7.7 / the
 *  `portal_caregiver_is_primary_or_dpoa` predicate). Anything else is refused. */
export type CaregiverAttestingRelationship = "primary_caregiver" | "dpoa_healthcare_agent";

/** The facts the caller resolves (upstream reader seams) + the caregiver's form input (§7.7 step 1/2). */
export interface CaregiverAttestationInput {
  readonly orgId: string;
  readonly patientId: PatientId;
  /** The M12 medication order the dose is attested against. */
  readonly medicationOrderId: string;
  /** Resolved from M12 `MedicationOrderProvider`: is the order still active AND caregiver-administered? */
  readonly orderActive: boolean;
  /** Resolved from M5: the caller's designated relationship to the patient (null when neither). */
  readonly attestingRelationship: CaregiverAttestingRelationship | null;
  /** §7.6 — true while the patient is in the post-discharge (non-death) read-only grace window. */
  readonly patientDischargedReadOnly: boolean;
  /** The attested administration time (ms epoch); form default = now, editable within ±2h. */
  readonly administeredAtMs: number;
  /** The §7.7 attestation checkbox ("I confirm this dose was administered as recorded…"). */
  readonly attestationChecked: boolean;
  /** Optional free-text note the caregiver entered. */
  readonly note?: string;
  /** The portal account the caregiver is authenticated as (linked on the M13 record per §7.7 step 3). */
  readonly portalAccountId: string;
}

/** The validated payload M31 hands M13's caregiver-attested write (the route maps it to `recordCaregiverAttested`). */
export interface CaregiverAttestationPayload {
  readonly orgId: string;
  readonly patientId: PatientId;
  readonly medicationOrderId: string;
  readonly administeredAtIso: string;
  readonly attestingRelationship: CaregiverAttestingRelationship;
  readonly note: string | null;
  readonly portalAccountId: string;
}

/**
 * Validate a caregiver dose attestation (§7.7 step 2) and produce the M13 write payload — or throw a
 * `PortalWriteError` naming the exact §7.7 negative path. PURE: no I/O; `nowMs` is injected.
 *
 * Guard order matches §7.7's negative-path list so the first failing precondition is the one reported:
 *   1. discharged-read-only  → PATIENT_DISCHARGED_READ_ONLY (§7.6)
 *   2. relationship          → ATTESTATION_RELATIONSHIP_FORBIDDEN (403; C is not primary/DPOA)
 *   3. order active          → ORDER_INACTIVE (410 Gone)
 *   4. dose-time window      → DOSE_TIME_OUT_OF_RANGE (±2h)
 *   5. attestation checkbox  → ATTESTATION_ABSENT
 */
export function planCaregiverAttestation(
  input: CaregiverAttestationInput,
  nowMs: number,
  windowMs: number = CAREGIVER_ATTEST_WINDOW_MS,
): CaregiverAttestationPayload {
  requirePortalWrite(
    !input.patientDischargedReadOnly,
    "PATIENT_DISCHARGED_READ_ONLY",
    "This patient was discharged. You retain read access for record review; attestation is disabled.",
  );
  requirePortalWrite(
    input.attestingRelationship !== null,
    "ATTESTATION_RELATIONSHIP_FORBIDDEN",
    "Only the primary caregiver or a healthcare DPOA may log a dose as given.",
  );
  requirePortalWrite(
    input.orderActive,
    "ORDER_INACTIVE",
    "This medication order is no longer active.",
  );
  // TIGHTEN-only: a tenant window may be smaller than the platform floor, never larger.
  const effectiveWindow = Math.min(windowMs, CAREGIVER_ATTEST_WINDOW_MS);
  requirePortalWrite(
    Math.abs(input.administeredAtMs - nowMs) <= effectiveWindow,
    "DOSE_TIME_OUT_OF_RANGE",
    "The time given must be within 2 hours of now.",
  );
  requirePortalWrite(
    input.attestationChecked,
    "ATTESTATION_ABSENT",
    "Please confirm the attestation before submitting.",
  );

  return {
    orgId: input.orgId,
    patientId: input.patientId,
    medicationOrderId: input.medicationOrderId,
    administeredAtIso: new Date(input.administeredAtMs).toISOString(),
    // Non-null after the guard above (asserts narrowing).
    attestingRelationship: input.attestingRelationship,
    note: input.note?.trim() ? input.note.trim() : null,
    portalAccountId: input.portalAccountId,
  };
}

/** The membership id M13 attributes a portal-attested administration to when there is no clinician actor —
 *  a SENTINEL, never a real membership (the M22 `*_by_membership_id` sentinel precedent). The route passes
 *  this to M13's write so the audit actor is unambiguous rather than an empty string. */
export const CAREGIVER_ATTESTED_ACTOR_SENTINEL: MembershipId = "portal_caregiver_attested";
