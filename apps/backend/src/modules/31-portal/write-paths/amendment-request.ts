// apps/backend/src/modules/31-portal/write-paths/amendment-request.ts — M31-T06 (§7.9 / HIPAA §164.526).
//
// The amendment-request write path. M5 OWNS the canonical `amendment_request` record, the 60-day SLA, the
// accept/deny + Statement-of-Disagreement workflow (§1.2 / §164.526). M31 hosts the SUBMIT surface: a portal
// caregiver or patient-self proposes a correction to an M5 demographics field or an M8 encounter narrative,
// M31 validates the shape and hands M5 the request via M5's amendment-submit surface. In the reduced 3-table
// scope M31 owns no `portal_amendment_request_ref` mirror table (ADR-0005 owns exactly three PHI tables), so
// the portal read of amendment status resolves through M5 on demand (T04 read-surface pattern) rather than a
// local mirror; this core owns only the §7.9 step-1 validation + the `m31.portal_amendment_request.submitted`
// outbox-event plan (a name in the T01 `M31_EVENT_NAMES` taxonomy).
//
// PURE: injected facts + the caregiver's form input in, a validated M5 submission payload or a
// `PortalWriteError` out. No I/O — the discharge-read-only fact is resolved by the caller (T07) via M6, and
// the actual M5 submit is the route's call to M5's amendment surface.
import type { PatientId } from "@chartwarden/types";
import { requirePortalWrite } from "./errors";

/** §7.9 — what the amendment targets. A demographics field lives on M5; a narrative correction targets an M8
 *  encounter. Both route to M5's §164.526 queue (M5 owns the canonical request either way). */
export type AmendmentTargetKind = "patient_demographic" | "encounter_narrative";

/** The §7.9 amendment submit input — the caller resolves the discharge state; the rest is the form. */
export interface AmendmentRequestInput {
  readonly orgId: string;
  readonly patientId: PatientId;
  readonly portalAccountId: string;
  readonly targetKind: AmendmentTargetKind;
  /** The specific field/encounter the amendment concerns (e.g. `dateOfBirth`, or an encounter id). */
  readonly targetRef: string;
  /** The requested change, free text (e.g. "Date of birth should be 1942-03-15, not 1943-03-15"). */
  readonly requestedChange: string;
  /** §7.6 — true while the patient is in the post-discharge (non-death) read-only grace window. */
  readonly patientDischargedReadOnly: boolean;
}

/** The validated payload M31 hands M5's amendment-submit surface (source stamped `portal`, §7.9 step 2). */
export interface AmendmentRequestPayload {
  readonly orgId: string;
  readonly patientId: PatientId;
  readonly targetKind: AmendmentTargetKind;
  readonly targetRef: string;
  readonly requestedChange: string;
  readonly source: "portal";
  readonly originatingPortalAccountId: string;
  readonly submittedEvent: "m31.portal_amendment_request.submitted";
}

/**
 * Validate a portal amendment request (§7.9 step 1) and produce the M5 submission payload — or throw a
 * `PortalWriteError`. PURE: no I/O. Guard order:
 *   1. discharged-read-only → PATIENT_DISCHARGED_READ_ONLY (§7.6)
 *   2. target + change present → AMENDMENT_TARGET_INVALID (M5 refuses an empty request; M31 refuses first)
 */
export function planAmendmentRequest(input: AmendmentRequestInput): AmendmentRequestPayload {
  requirePortalWrite(
    !input.patientDischargedReadOnly,
    "PATIENT_DISCHARGED_READ_ONLY",
    "This patient was discharged. You retain read access for record review; amendment requests are disabled.",
  );
  requirePortalWrite(
    input.targetRef.trim().length > 0 && input.requestedChange.trim().length > 0,
    "AMENDMENT_TARGET_INVALID",
    "Please describe both what should change and the correction you are requesting.",
  );

  return {
    orgId: input.orgId,
    patientId: input.patientId,
    targetKind: input.targetKind,
    targetRef: input.targetRef.trim(),
    requestedChange: input.requestedChange.trim(),
    source: "portal",
    originatingPortalAccountId: input.portalAccountId,
    submittedEvent: "m31.portal_amendment_request.submitted",
  };
}
