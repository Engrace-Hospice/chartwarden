// apps/backend/src/modules/22-documents/render-pdf/forms/billing-forms.ts - the billing correspondence M22 draws
// (GAP-033 Wave 3): the NOE / NOTR confirmation receipts, the Medicare and Medicaid claim acknowledgment letters,
// the denial-appeal cover letter and the denial-resolution letter. These are receipts and letters the hospice
// files, not CMS-prescribed forms, so the fixed wording below is the platform's own and deliberately limited to
// what the event proves: a submission happened, a payer accepted a claim for adjudication, a claim was rejected
// at a stage with codes. None of them states coverage, payment or an appeal deadline - nothing on the wire
// supports it. They carry no patient identity and no MBI by design (the producers' D13 contract): control
// numbers, dates and codes only, so they are patient-independent letters with a constant title.
import {
  assertClaimAcknowledgmentRenderPayload,
  assertDenialAppealCoverRenderPayload,
  assertDenialResolutionRenderPayload,
  assertMedicaidClaimAcknowledgmentRenderPayload,
  assertNoeReceiptRenderPayload,
  assertNotrReceiptRenderPayload,
} from "@chartwarden/types";
import { fmtInstant, humanize, shortId } from "../shared";
import { defineForm } from "./compile";

const NOT_A_DETERMINATION =
  "This document records an administrative event. It is not a determination of coverage, eligibility or payment.";

export const BILLING_TEXT = {
  noe: "This receipt confirms that the Notice of Election identified below was submitted for processing on the date shown. Keep it with the patient's billing record.",
  notr: "This receipt confirms that the Notice of Termination or Revocation identified below was submitted for processing on the date shown. Keep it with the patient's billing record.",
  claimAck:
    "The payer acknowledged the claim identified below and accepted it for adjudication on the date shown.",
  medicaidClaimAck:
    "The Medicaid payer acknowledged the claim identified below and accepted it for adjudication on the date shown.",
  denialCover:
    "This cover letter accompanies the record of a claim that was rejected before adjudication. It lists the claim, the stage that rejected it and the rejection codes returned, for the appeal or correction file.",
  denialResolution:
    "The denial case identified below has been closed. The closure outcome and date are recorded here for the claim file.",
  notDetermination: NOT_A_DETERMINATION,
} as const;

export const BILLING_FORM_VERSION = "1.0.0";

const STAGE_LABELS: Readonly<Record<string, string>> = {
  clearinghouse: "Clearinghouse edit check (before the payer)",
  "999": "999 implementation acknowledgment (file level)",
  "277ca": "277CA claim acknowledgment (claim level)",
};

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  resolved_no_appeal: "Resolved without appeal",
  resolved_via_appeal: "Resolved through appeal",
  written_off: "Written off",
};

const payerRef = (v: string | null | undefined): string => v ?? "Not yet assigned by the payer";

export const noeReceiptForm = defineForm({
  key: "noe_confirmation_receipt",
  version: BILLING_FORM_VERSION,
  title: "Notice of Election - Confirmation Receipt",
  authority: "42 CFR 418.24; M23 NOE submission",
  parse: assertNoeReceiptRenderPayload,
  patient: () => null,
  hospiceName: () => null,
  documentDate: (p) => p.submittedAt,
  sections: [
    { id: "receipt_statement", kind: "legal", text: BILLING_TEXT.noe },
    {
      id: "submission_details",
      kind: "fields",
      heading: "Submission",
      cells: (p) => [
        ["NOE control number", p.noeControlNumber],
        ["Submitted", fmtInstant(p.submittedAt)],
      ],
    },
    { id: "not_a_determination", kind: "legal", text: NOT_A_DETERMINATION },
  ],
  signatures: [],
});

export const notrReceiptForm = defineForm({
  key: "notr_confirmation_receipt",
  version: BILLING_FORM_VERSION,
  title: "Notice of Termination or Revocation - Confirmation Receipt",
  authority: "M23 NOTR submission",
  parse: assertNotrReceiptRenderPayload,
  patient: () => null,
  hospiceName: () => null,
  documentDate: (p) => p.submittedAt,
  sections: [
    { id: "receipt_statement", kind: "legal", text: BILLING_TEXT.notr },
    {
      id: "submission_details",
      kind: "fields",
      heading: "Submission",
      cells: (p) => [
        ["NOTR control number", p.notrControlNumber],
        ["Submitted", fmtInstant(p.submittedAt)],
      ],
    },
    { id: "not_a_determination", kind: "legal", text: NOT_A_DETERMINATION },
  ],
  signatures: [],
});

export const claimAcknowledgmentForm = defineForm({
  key: "claim_acknowledgment_letter",
  version: BILLING_FORM_VERSION,
  title: "Claim Acknowledgment Letter",
  authority: "M23 277CA acknowledgment",
  parse: assertClaimAcknowledgmentRenderPayload,
  patient: () => null,
  hospiceName: () => null,
  documentDate: (p) => p.acknowledgedAt,
  sections: [
    { id: "acknowledgment_statement", kind: "legal", text: BILLING_TEXT.claimAck },
    {
      id: "claim_details",
      kind: "fields",
      heading: "Claim",
      cells: (p) => [
        ["Claim control number", p.claimControlNumber],
        ["Payer claim control number", payerRef(p.payerClaimControlNumber)],
        ["Acknowledged", fmtInstant(p.acknowledgedAt)],
      ],
    },
    { id: "not_a_determination", kind: "legal", text: NOT_A_DETERMINATION },
  ],
  signatures: [],
});

export const medicaidClaimAcknowledgmentForm = defineForm({
  key: "medicaid_claim_acknowledgment_letter",
  version: BILLING_FORM_VERSION,
  title: "Medicaid Claim Acknowledgment Letter",
  authority: "M24 277CA acknowledgment",
  parse: assertMedicaidClaimAcknowledgmentRenderPayload,
  patient: () => null,
  hospiceName: () => null,
  documentDate: (p) => p.acknowledgedAt,
  sections: [
    { id: "acknowledgment_statement", kind: "legal", text: BILLING_TEXT.medicaidClaimAck },
    {
      id: "claim_details",
      kind: "fields",
      heading: "Claim",
      cells: (p) => [
        ["Medicaid claim control number", p.medicaidClaimControlNumber],
        ["Payer claim control number", payerRef(p.payerClaimControlNumber)],
        ["Acknowledged", fmtInstant(p.acknowledgedAt)],
      ],
    },
    { id: "not_a_determination", kind: "legal", text: NOT_A_DETERMINATION },
  ],
  signatures: [],
});

export const denialAppealCoverForm = defineForm({
  key: "denial_appeal_cover_letter",
  version: BILLING_FORM_VERSION,
  title: "Claim Rejection - Appeal Cover Letter",
  authority: "M23 claim rejection; M25 appeal file",
  parse: assertDenialAppealCoverRenderPayload,
  patient: () => null,
  hospiceName: () => null,
  // The rejection event carries no timestamp of its own; the letter states none rather than invent one.
  documentDate: () => null,
  sections: [
    { id: "cover_statement", kind: "legal", text: BILLING_TEXT.denialCover },
    {
      id: "rejection_details",
      kind: "fields",
      heading: "Rejection",
      cells: (p) => [
        ["Claim control number", p.claimControlNumber],
        ["Rejected at", STAGE_LABELS[p.rejectionStage] ?? humanize(p.rejectionStage)],
      ],
    },
    {
      id: "rejection_codes",
      kind: "list",
      heading: "Rejection codes returned",
      items: (p) => p.rejectionCodes,
      emptyText: "No rejection codes were returned with the rejection.",
    },
    { id: "not_a_determination", kind: "legal", text: NOT_A_DETERMINATION },
  ],
  signatures: [],
});

export const denialResolutionForm = defineForm({
  key: "denial_resolution_letter",
  version: BILLING_FORM_VERSION,
  title: "Denial Resolution Letter",
  authority: "M25 denial management",
  parse: assertDenialResolutionRenderPayload,
  patient: () => null,
  hospiceName: () => null,
  documentDate: (p) => p.resolvedAt,
  sections: [
    { id: "resolution_statement", kind: "legal", text: BILLING_TEXT.denialResolution },
    {
      id: "resolution_details",
      kind: "fields",
      heading: "Resolution",
      cells: (p) => [
        ["Closure outcome", OUTCOME_LABELS[p.closureOutcome] ?? humanize(p.closureOutcome)],
        ["Resolved", fmtInstant(p.resolvedAt)],
        ["Claim reference", p.claimId ? shortId(p.claimId) : "No claim attached to this denial"],
      ],
    },
    { id: "not_a_determination", kind: "legal", text: NOT_A_DETERMINATION },
  ],
  signatures: [],
});
