// apps/backend/src/modules/25-remittance/routes/linked-document.ts - M25 milestone 13a: the ONE check every "link an M22
// document" path of the beneficiary appeal and the appointment of representative runs BEFORE linking.
//
//   1. the appeal enclosure rules (`describeEnclosures`): visible to the org, ACTIVE or on hold, the patient's, never 42 CFR
//      Part 2; a refusal carries a reason code and never the document's title;
//   2. M22's shared ACTIVE-VERSION check (`DocumentReader.activeVersionLink`, the one M6 uses for admission evidence): the
//      version the caller names must be the document's active version, the document must be linked to the same patient, and,
//      when the document is linked to an admission and the caller names one, to that admission.
// The validated version id is what the caller persists, so a later supersession is visible and never silently re-pointed.
import { runWithRequestContext } from "@chartwarden/tenancy";
import { ChartWardenError, type DocumentReader } from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";
import { describeEnclosures } from "./appeal-packet-sources";

/** M22's `DocumentReader`, narrowed to the two arms the link check reads. */
export type LinkedDocumentPort = Pick<DocumentReader, "documentMetadata" | "activeVersionLink">;

/** The production port: M22's published seam, resolved lazily and opened under an explicit org context. */
export function buildSeamLinkedDocumentPort(): () => LinkedDocumentPort {
  return () => ({
    documentMetadata: (args) =>
      runWithRequestContext({ organizationId: args.organizationId, userId: "" }, () =>
        (getSeam("DocumentReader") as LinkedDocumentPort).documentMetadata(args),
      ),
    activeVersionLink: (args) =>
      runWithRequestContext({ organizationId: args.organizationId, userId: "" }, () =>
        (getSeam("DocumentReader") as LinkedDocumentPort).activeVersionLink(args),
      ),
  });
}

/** No port bound: a document that cannot be validated is refused, never linked on trust. */
export const UNBOUND_LINKED_DOCUMENTS: () => LinkedDocumentPort = () => {
  throw new ChartWardenError("SEAM_UNBOUND", "the document source is not bound", 503);
};

export interface LinkedDocumentScope {
  readonly patientId: string;
  /** Set when the document must also belong to this admission (when the document names one). */
  readonly admissionId?: string | null;
}

export interface ValidatedDocument {
  readonly documentId: string;
  readonly documentVersionId: string;
}

const unprocessable = (code: string, message: string) => new ChartWardenError(code, message, 422);

export async function validateLinkedDocument(
  port: LinkedDocumentPort,
  organizationId: string,
  scope: LinkedDocumentScope,
  ids: ValidatedDocument,
  subject: string,
): Promise<ValidatedDocument> {
  await describeEnclosures(
    port,
    organizationId,
    scope.patientId,
    [ids.documentId],
    undefined,
    subject,
  );
  const link = await port.activeVersionLink({
    organizationId: organizationId as never,
    documentId: ids.documentId as never,
    documentVersionId: ids.documentVersionId as never,
  });
  if (!link) {
    throw unprocessable(
      "DOCUMENT_VERSION_UNAVAILABLE",
      "that document version is not the document's active version; pick the current version",
    );
  }
  if (link.patientId !== scope.patientId) {
    throw unprocessable(
      "DOCUMENT_PATIENT_MISMATCH",
      "the document is not linked to this claim's patient",
    );
  }
  if (scope.admissionId && link.admissionId !== null && link.admissionId !== scope.admissionId) {
    throw unprocessable(
      "DOCUMENT_ADMISSION_MISMATCH",
      "the document is linked to a different admission than this claim's",
    );
  }
  return { documentId: ids.documentId, documentVersionId: ids.documentVersionId };
}
