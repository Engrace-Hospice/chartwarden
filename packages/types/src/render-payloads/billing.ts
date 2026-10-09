// @wardenx/types - the typed render payloads of the billing correspondence M22 draws (GAP-033, Wave 3): the NOE and
// NOTR confirmation receipts, the Medicare and Medicaid claim acknowledgment letters, the denial-appeal cover
// letter and the denial-resolution letter. Unlike the M6 CoP documents these producers (M23 `consumers/
// document-render.ts`, M24 `submission-jobs.ts`, M25 `write-service-drizzle.ts`) already ship the content, so the
// schemas below validate what is ALREADY on the wire; M22 draws only the declared fields (an allow-list), and a
// payload missing the control number / date a receipt exists to state fails closed instead of drawing a blank
// receipt. Payloads are PHI-free by design (D13): control numbers, dates and codes, never the MBI.
import { type Static, Type } from "@sinclair/typebox";
import { assertRenderPayload } from "./common";

const text = Type.String({ minLength: 1 });
const nullableText = Type.Union([text, Type.Null()]);

export const NoeReceiptRenderPayload = Type.Object({
  noeControlNumber: text,
  submittedAt: text,
});
export type NoeReceiptRenderPayload = Static<typeof NoeReceiptRenderPayload>;
export const assertNoeReceiptRenderPayload = (p: unknown): NoeReceiptRenderPayload =>
  assertRenderPayload("noe_confirmation_receipt", NoeReceiptRenderPayload, p);

export const NotrReceiptRenderPayload = Type.Object({
  notrControlNumber: text,
  submittedAt: text,
});
export type NotrReceiptRenderPayload = Static<typeof NotrReceiptRenderPayload>;
export const assertNotrReceiptRenderPayload = (p: unknown): NotrReceiptRenderPayload =>
  assertRenderPayload("notr_confirmation_receipt", NotrReceiptRenderPayload, p);

export const ClaimAcknowledgmentRenderPayload = Type.Object({
  claimControlNumber: text,
  /** The payer's own claim control number; null until the payer assigned one. */
  payerClaimControlNumber: Type.Optional(nullableText),
  acknowledgedAt: text,
});
export type ClaimAcknowledgmentRenderPayload = Static<typeof ClaimAcknowledgmentRenderPayload>;
export const assertClaimAcknowledgmentRenderPayload = (
  p: unknown,
): ClaimAcknowledgmentRenderPayload =>
  assertRenderPayload("claim_acknowledgment_letter", ClaimAcknowledgmentRenderPayload, p);

export const MedicaidClaimAcknowledgmentRenderPayload = Type.Object({
  medicaidClaimControlNumber: text,
  payerClaimControlNumber: Type.Optional(nullableText),
  acknowledgedAt: text,
});
export type MedicaidClaimAcknowledgmentRenderPayload = Static<
  typeof MedicaidClaimAcknowledgmentRenderPayload
>;
export const assertMedicaidClaimAcknowledgmentRenderPayload = (
  p: unknown,
): MedicaidClaimAcknowledgmentRenderPayload =>
  assertRenderPayload(
    "medicaid_claim_acknowledgment_letter",
    MedicaidClaimAcknowledgmentRenderPayload,
    p,
  );

export const DenialAppealCoverRenderPayload = Type.Object({
  claimControlNumber: text,
  /** The pipeline stage that rejected the claim (front-end edit, clearinghouse, payer ...). */
  rejectionStage: text,
  rejectionCodes: Type.Array(text),
});
export type DenialAppealCoverRenderPayload = Static<typeof DenialAppealCoverRenderPayload>;
export const assertDenialAppealCoverRenderPayload = (p: unknown): DenialAppealCoverRenderPayload =>
  assertRenderPayload("denial_appeal_cover_letter", DenialAppealCoverRenderPayload, p);

export const DenialResolutionRenderPayload = Type.Object({
  closureOutcome: text,
  resolvedAt: text,
  /** The claim the denial was raised against; null for a denial with no claim attached yet. */
  claimId: Type.Optional(nullableText),
});
export type DenialResolutionRenderPayload = Static<typeof DenialResolutionRenderPayload>;
export const assertDenialResolutionRenderPayload = (p: unknown): DenialResolutionRenderPayload =>
  assertRenderPayload("denial_resolution_letter", DenialResolutionRenderPayload, p);
