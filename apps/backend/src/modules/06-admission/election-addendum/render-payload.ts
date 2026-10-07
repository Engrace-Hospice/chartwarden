// apps/backend/src/modules/06-admission/election-addendum/render-payload.ts — the per-patient content M22
// renders one addendum version from (418.24(c)(1)–(10)). PURE over the row; the fixed regulatory language
// lives in M22's template (render-pdf/election-addendum-doc.ts).
import {
  ELECTION_ADDENDUM_TITLE,
  type ElectionAddendumRenderPayload,
  type LocalDate,
} from "@wardenx/types";
import { localDateOfInstant } from "../certification/window-math";
import type { AddendumRow } from "./store";

const dateOrNull = (d: Date | null, tz: string): LocalDate | null =>
  d ? localDateOfInstant(d.toISOString(), tz) : null;

/** A scanned paper copy filed for the version that the row does not carry yet (the furnish step of the
 *  furnish-then-acknowledge transaction on the paper path). */
export interface ScannedCopyRef {
  readonly documentId: string;
  readonly filedAt: Date;
}

/** Build the render payload for a furnished (or later) version. Throws if the version was never furnished. */
export function buildAddendumRenderPayload(
  row: AddendumRow,
  timeZone: string,
  pendingScan?: ScannedCopyRef,
): ElectionAddendumRenderPayload {
  if (!row.furnishedAt || !row.furnishMethod) {
    throw new Error(`election addendum ${row.id} has not been furnished`);
  }
  const outcome =
    row.status === "signed" || row.status === "refused" || row.status === "signature_not_required"
      ? row.status
      : "pending";
  // The row's own scanned acknowledgement wins; it was filed in the acknowledging write (`updated_at`).
  const scan: ScannedCopyRef | null =
    row.acknowledgementSource === "uploaded" && row.acknowledgementDocumentId
      ? { documentId: row.acknowledgementDocumentId, filedAt: row.updatedAt }
      : (pendingScan ?? null);
  return {
    title: ELECTION_ADDENDUM_TITLE,
    patientId: row.patientId,
    electionAddendumId: row.id,
    versionNumber: row.versionNumber,
    trigger: row.trigger,
    hospiceName: row.hospiceName ?? "",
    patientName: row.patientName ?? "",
    medicalRecordNumber: row.medicalRecordNumber ?? "",
    terminalDiagnoses: row.terminalDiagnosis,
    relatedDiagnoses: row.relatedDiagnoses,
    items: row.items.map((i) => ({
      category: i.category,
      description: i.description,
      reasonNotCovered: i.reasonNotCovered,
    })),
    noNonCoveredItems: row.noNonCoveredItems,
    clinicalExplanation: row.clinicalExplanation,
    guidelineReferences: row.guidelineReferences,
    furnishedDate: localDateOfInstant(row.furnishedAt.toISOString(), timeZone),
    furnishMethod: row.furnishMethod,
    contentSource: row.contentSource,
    scannedCopy: scan
      ? {
          documentId: scan.documentId,
          filedDate: localDateOfInstant(scan.filedAt.toISOString(), timeZone),
        }
      : null,
    acknowledgement: {
      source: row.acknowledgementSource,
      outcome,
      signedDate: dateOrNull(row.signedAt, timeZone),
      signerKind: row.signerKind,
      representativeName: row.representativeName,
      representativeRelationship: row.representativeRelationship,
      refusalReason: row.refusalReason,
      exemptionReason: row.signatureNotRequiredReason,
      exemptionNote: row.signatureNotRequiredNote,
    },
  };
}
