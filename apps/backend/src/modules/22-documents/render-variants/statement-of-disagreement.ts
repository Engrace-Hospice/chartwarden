// apps/backend/src/modules/22-documents/render-variants/statement-of-disagreement.ts — M22-T09 the §7.5 W5
// Statement-of-Disagreement (SoD) attachment (D13). PURE planning over the T03 `planAddVersion` versioning
// machine + the §7.2 W2 render handshake.
//
// HIPAA §164.526 right-to-amend: when M5 DENIES a patient amendment, M5 emits `m5.patient.amendment_decided`
// with `decision='denied'`. M22 then renders the `patient_amendment_statement_of_disagreement` template
// hydrated with the statement text + amendment metadata, and creates the document `compliance`-class with
// `attach_to_disclosures=true`, tagged `original_amendment_request_id=<id>`. The SoD does NOT alter the
// original record — it is a LINKED ADDENDUM VERSION (the T03 append-only D2 shape: a NEW `document_version`
// + an `active_version_id` flip; the original version is preserved). From then on every disclosure of the
// underlying record must carry the attached SoD (D13).
//
// Pure: this plans the version-append + the attach/tag side-effects as DATA; the live consumer (deferred,
// like T06) renders via the T04 `DocumentRenderer` seam, applies the tag/flag, and emits
// `m22.document.statement_of_disagreement_published`. No DB, no producer import (the M5 payload is a
// locally-declared structural minimum; M22 deps stay [1, 5]).
import type { DocumentSideEffect, DocumentTransitionResult } from "../lifecycle/effects";
import { type AddVersionPlan, planAddVersion } from "../lifecycle/version";

/** The `m5.patient.amendment_decided` payload, as M5 hands it on the outbox when an amendment is DENIED
 * (structural minimum — M5 owns the canonical amendment row; M22 reads the SoD text + routing keys). */
export interface AmendmentDeniedPayload {
  readonly amendmentId: string;
  readonly patientId: string;
  readonly organizationId: string;
  readonly decision: "denied" | "approved" | "partially_approved";
  /** The patient's verbatim statement-of-disagreement text (hydrated by M5's `PatientReader`/amendment lookup). */
  readonly statementText: string;
  /** The denial detail M22 renders alongside the patient statement (the privacy officer's recorded reason). */
  readonly denialReason?: string;
}

/** The §7.5 tag key M22 stamps on the SoD document so the disclosure subsetter can join it to the amended
 * record (D13). The value is the originating M5 amendment-request id. */
export const SOD_AMENDMENT_TAG = "original_amendment_request_id" as const;

/** The render-content the W2 handshake feeds the `patient_amendment_statement_of_disagreement` template. */
export interface SodRenderContent {
  readonly amendmentId: string;
  readonly patientId: string;
  readonly statementText: string;
  readonly denialReason: string | null;
}

/** The full SoD-attachment plan: the template-key + content for the W2 render, the version-append result
 * (T03), and the §7.5 attach/tag side-effects layered on top. The live consumer executes these in one tx. */
export interface SodAttachmentPlan {
  readonly templateKey: "patient_amendment_statement_of_disagreement";
  readonly content: SodRenderContent;
  readonly version: DocumentTransitionResult<"active", "addVersion">;
  /** The §7.5 attach/tag effects appended to the version effects: set `attach_to_disclosures`, tag the
   * amendment id, and publish `m22.document.statement_of_disagreement_published`. */
  readonly attachEffects: ReadonlyArray<DocumentSideEffect>;
}

/** Raised when the SoD pipeline is fed a non-denied amendment decision — M22 only renders a SoD on a DENIAL
 * (§7.5 step 2; an approved/partially-approved amendment is M5's edit path, not a SoD). */
export class StatementOfDisagreementError extends Error {
  readonly code = "SOD_NOT_A_DENIAL";
  constructor(decision: string) {
    super(`statement of disagreement is only rendered for a denied amendment (got '${decision}')`);
    this.name = "StatementOfDisagreementError";
  }
}

/**
 * Plan the §7.5 W5 Statement-of-Disagreement attachment (D13, pure). Refuses anything but a `denied`
 * decision, then plans the LINKED ADDENDUM VERSION via the T03 `planAddVersion` machine (append-only; the
 * original version is preserved — the SoD does NOT alter the original) and layers the §7.5 attach/tag
 * effects on top: set `document.attach_to_disclosures=true`, stamp the `original_amendment_request_id` tag,
 * and publish `m22.document.statement_of_disagreement_published`. The live consumer renders the bytes via
 * the T04 `DocumentRenderer` seam and executes the returned effects in the document's tx.
 *
 * `currentMaxVersion === 0` (the SoD is the genesis version on a fresh SoD document) → v1, `m22.document.created`.
 * A re-attach on an existing SoD document appends n≥2 (`m22.document.versioned`), preserving the prior SoD.
 */
export function planStatementOfDisagreement(args: {
  readonly payload: AmendmentDeniedPayload;
  readonly versionId: string;
  readonly currentMaxVersion: number;
}): SodAttachmentPlan {
  const { payload } = args;
  if (payload.decision !== "denied") {
    throw new StatementOfDisagreementError(payload.decision);
  }

  const isFirstVersion = args.currentMaxVersion === 0;
  const addPlan: AddVersionPlan = {
    versionId: args.versionId,
    versionNumber: args.currentMaxVersion + 1,
    isFirstVersion,
    isCorrection: false, // a SoD is an addendum, never a correction of the original (§7.5)
    supersedePrior: false, // append-only; the original record is preserved (D13)
  };
  const version = planAddVersion({
    documentId: payload.amendmentId, // routing only — the live consumer owns the real document id
    currentMaxVersion: args.currentMaxVersion,
    plan: addPlan,
  });

  // §7.5 step 4–5: mark `attach_to_disclosures`, tag the amendment id, publish the SoD event.
  const attachEffects: DocumentSideEffect[] = [
    { kind: "set_field", field: "attach_to_disclosures", value: "true" },
    { kind: "set_field", field: SOD_AMENDMENT_TAG, value: payload.amendmentId },
    { kind: "outbox", event: "m22.document.statement_of_disagreement_published" },
  ];

  const content: SodRenderContent = {
    amendmentId: payload.amendmentId,
    patientId: payload.patientId,
    statementText: payload.statementText,
    denialReason: payload.denialReason ?? null,
  };

  return {
    templateKey: "patient_amendment_statement_of_disagreement",
    content,
    version,
    attachEffects,
  };
}
