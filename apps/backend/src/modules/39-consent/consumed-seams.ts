// apps/backend/src/modules/39-consent/consumed-seams.ts — M39-T06 (spec §4.4).
//
// The seams M39 CONSUMES, resolved through the M1 registry (ADR-0005 D1 — no manifest import edge to
// the producer package; the INTERFACE comes from the leaf @chartwarden/types, the IMPL from getSeam()):
//
//   • PatientReader (M5, §4.8) — REAL. M5 registered it at boot (M5-T08). M39 uses it for
//     grantor/subject IDENTITY resolution (resolve the patient a consent is about, merge-redirect
//     aware ≤3 hops). `patient.deceased` state (D13 post-death scope) arrives via the
//     `m5.patient.deceased` OUTBOX event (T08 consumer), NOT a PatientReader call; the M5
//     privacy_flag_snapshot is M5-OWNED and recomputed FROM M39's events (M5 D10) — M39 does not read
//     it back through this seam (it has no such method), so HIV/MH/genetic redaction stays fail-closed
//     in the evaluator (§4.3.1) rather than M39 inventing a disclose decision it cannot back.
//
//   • DocumentRenderer (M22, §4.4/D15) — NOW REAL (M22-T04 registered the W2 render handshake over the
//     boot deny-stub). ADR-0006 dropped the 22→39 manifest edge (M39 consumes M22's renderer, not the
//     reverse). getSeam("DocumentRenderer") resolves to M22's real publisher, so the signed-PDF render
//     path (emit m39.consent.signed → render the `consent_record` template) materializes the artifact
//     (the deny-stub stays the fail-closed default the registry applies if M22 is ever absent). No import
//     of any @chartwarden/documents package here — the type is the leaf one, the impl is resolved at call
//     time — so arch:boundaries stays edge-free (no 22→39).
import type { DocumentRenderer, OrgScope, PatientIdentity, PatientReader } from "@chartwarden/types";
import { getSeam } from "../../bootstrap/index";

/** Typed resolver for M5's real `PatientReader` (registered at boot; validateSeams guarantees it). */
export function getConsentPatientReader(): PatientReader {
  return getSeam("PatientReader");
}

/** Typed resolver for M22's `DocumentRenderer` — REAL since M22-T04 (registered over the boot deny-stub). */
export function getConsentDocumentRenderer(): DocumentRenderer {
  return getSeam("DocumentRenderer");
}

/**
 * Resolve the patient a consent record is ABOUT (grantor/subject identity), merge-redirect aware.
 * Returns null if the id resolves to no live patient in the org. Used by the consent-record service
 * (T07/T09) to validate `patient_id` and to follow a merged patient to its survivor (the consent
 * stays attached to the surviving record).
 */
export async function resolvePatientForConsent(
  reader: PatientReader,
  input: { organizationId: string; patientId: string },
): Promise<PatientIdentity | null> {
  return reader.findById({ organizationId: input.organizationId, id: input.patientId });
}

/** The typed payload M39 hands M22 to render the §164.508(c)(2) `consent_record` writing (D15). M22
 *  owns the template (`consent_record` key, M22 D14); M39 supplies the consent facts. */
export interface ConsentRecordRenderPayload {
  /** The W2 render aggregate id (§7.2 step 6) — the consent record id M22 keys the rendered document on. */
  readonly aggregateId: string;
  readonly consentRecordId: string;
  readonly patientId: string;
  readonly typeKey: string;
  readonly grantorKind: string;
  readonly effectiveAt: string;
  readonly expiresAt?: string;
  readonly recipients: readonly { kind: string; displayName: string }[];
  readonly jurisdictionCode?: string;
}

/**
 * D15 signed-PDF render request: emit the `consent_record` template render through M22's renderer.
 * REAL since M22-T04 — M22's W2 handshake materializes the `consent_record` document. The caller (the
 * m22-render-emitter service, T08/T09) invokes this after `m39.consent.signed`; M22's
 * `m22.document.rendered` back-ref then stamps `consent_document_link` (T08 consumer).
 */
export async function renderConsentRecordDocument(
  scope: OrgScope,
  payload: ConsentRecordRenderPayload,
): Promise<{ documentId: string }> {
  return getConsentDocumentRenderer().render(scope, "consent_record", payload);
}
