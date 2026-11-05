// apps/web/src/modules/31-portal — staff "Signatures" chart tab model (ADR-0107). Pure: labels, tones and the
// send-dialog option rules, so the screen stays presentation and the rules are unit-testable. The server stays the
// authority on every rule here (a hidden option is a convenience, never a control).
import type { StatusTone } from "@chartwarden/ui";

export type DocKind =
  | "election_statement"
  | "notice_of_patient_rights"
  | "hipaa_npp_acknowledgement"
  | "consent_to_treat";
export type RequestStatus = "pending" | "uploaded_pending_review" | "signed" | "voided";
export type VoidReason =
  | "sent_in_error"
  | "document_superseded"
  | "patient_declined"
  | "patient_unreachable"
  | "signed_on_paper";

/** The slice of a staff signature-request row this screen reads. It never carries the signer's typed text. */
export interface SignatureRequestRow {
  id: string;
  patientId: string;
  docKind: DocKind;
  status: RequestStatus;
  templateVersion: string;
  requestedAt: string;
  lastRemindedAt: string | null;
  reminderCount: number;
  signedAt: string | null;
  signerRole: "patient" | "legal_representative" | "caregiver_on_behalf" | null;
  voidReason: string | null;
  uploadedDocumentId: string | null;
  reviewOutcome: "accepted" | "rejected" | null;
}

export const DOC_LABEL: Record<DocKind, string> = {
  election_statement: "Hospice election statement",
  notice_of_patient_rights: "Notice of patient rights",
  hipaa_npp_acknowledgement: "Notice of privacy practices",
  consent_to_treat: "Consent to treat",
};

export const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "Waiting for signature",
  uploaded_pending_review: "Copy awaiting review",
  signed: "Signed",
  voided: "Withdrawn",
};

export const STATUS_TONE: Record<RequestStatus, StatusTone> = {
  pending: "progress",
  uploaded_pending_review: "warning",
  signed: "success",
  voided: "neutral",
};

export const SIGNER_LABEL: Record<NonNullable<SignatureRequestRow["signerRole"]>, string> = {
  patient: "Patient",
  legal_representative: "Legal representative",
  caregiver_on_behalf: "Family caregiver",
};

export const VOID_REASON_LABEL: Record<VoidReason, string> = {
  sent_in_error: "Sent in error",
  document_superseded: "Replaced by a newer document",
  patient_declined: "Patient declined",
  patient_unreachable: "Patient could not be reached",
  signed_on_paper: "Signed on paper",
};
export const VOID_REASONS = Object.keys(VOID_REASON_LABEL) as VoidReason[];

export interface SendOption {
  readonly kind: DocKind;
  readonly label: string;
  /** The M06 record this document signs into; required by the server for the election and the notice of rights. */
  readonly targetRef?: string;
  readonly hint?: string;
}

/**
 * What the send dialog offers. The privacy notice and consent are always offered; the election needs the patient's
 * still-drafted statement and the notice of rights needs their admission, so each appears only when that record is known.
 */
export function sendOptions(known: {
  draftedElectionStatementId: string | null;
  admissionId: string | null;
}): SendOption[] {
  const out: SendOption[] = [
    { kind: "hipaa_npp_acknowledgement", label: DOC_LABEL.hipaa_npp_acknowledgement },
    {
      kind: "consent_to_treat",
      label: `${DOC_LABEL.consent_to_treat} (pending legal review)`,
      hint: "Pending legal review: patients cannot sign this one yet.",
    },
  ];
  if (known.draftedElectionStatementId)
    out.push({
      kind: "election_statement",
      label: DOC_LABEL.election_statement,
      targetRef: known.draftedElectionStatementId,
    });
  if (known.admissionId)
    out.push({
      kind: "notice_of_patient_rights",
      label: DOC_LABEL.notice_of_patient_rights,
      targetRef: known.admissionId,
    });
  return out;
}

/** The refusal text for an API error body (`{ error: { code, message } }`), by code where we have our own wording. */
export function refusalMessage(error: unknown, fallback: string): string {
  const e = (error as { error?: { code?: string; message?: string } } | null)?.error;
  switch (e?.code) {
    case "SIGNATURE_REQUEST_ALREADY_OPEN":
      return "A request for this document is already open for this patient.";
    case "SIGNATURE_TARGET_INVALID":
      return "That record cannot be sent for signature for this patient.";
    case "M06_DOCUMENT_RECORDED_IN_ADMISSION":
      return "Record this paper signature in the admission workflow, then withdraw the request as signed on paper.";
    default:
      return e?.message ?? fallback;
  }
}
