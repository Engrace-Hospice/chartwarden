// apps/backend/src/modules/06-admission/admission-document-validator.ts — the ONE check every M6 "attach an
// uploaded document" path runs (NOR / election statement / CTI evidence, and the scanned election addendum):
// the M22 version must be the document's ACTIVE version and the document must be linked to the same patient and
// admission. Read through M22's published `DocumentReader` seam (M6 does not list M22 in `dependsOn`, so it may not
// import M22 — the seam's leaf-typed contract is the sanctioned path). The seam is resolved per call, so boot
// registration order never matters.
import { type DocumentReader, ChartWardenError } from "@wardenx/types";
import type { AdmissionEvidenceDocumentValidator } from "./admission-evidence-service";

export function createDocumentReaderEvidenceValidator(
  reader: () => Pick<DocumentReader, "activeVersionLink">,
): AdmissionEvidenceDocumentValidator {
  return {
    async validateAdmissionEvidenceDocumentVersion(args) {
      const link = await reader().activeVersionLink({
        organizationId: args.organizationId,
        documentId: args.documentId,
        documentVersionId: args.documentVersionId,
      });
      if (!link) {
        throw new ChartWardenError(
          "DOCUMENT_VERSION_UNAVAILABLE",
          "The document version is no longer available.",
          400,
        );
      }
      if (link.patientId !== args.patientId || link.admissionId !== args.admissionId) {
        throw new ChartWardenError(
          "ADMISSION_EVIDENCE_DOCUMENT_MISMATCH",
          "The uploaded document is not linked to this admission and patient.",
          400,
        );
      }
    },
  };
}
