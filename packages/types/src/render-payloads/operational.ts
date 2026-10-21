// @chartwarden/types - the typed render payloads of the operational documents M22 draws (GAP-033, Wave 4): the
// caregiver visit-confirmation reminder (M17), the EVV verification record (M18), the DSAR export transmittal
// sheet and the tenant-export cover letter (M34). Like the billing correspondence, these producers already put
// the whole content on the wire (the M17 / M18 outbox events, the M34 direct `DocumentRenderer.render()` args), so
// the schemas validate what is ALREADY sent; M22 draws only the declared fields. A payload missing the reference
// or digest the document exists to state fails closed (retry -> DLQ) instead of drawing a blank sheet.
import { type Static, Type } from "@sinclair/typebox";
import { assertRenderPayload } from "./common";

const text = Type.String({ minLength: 1 });
const nullableText = Type.Union([text, Type.Null()]);
/** A lowercase hex SHA-256 digest: the sheet exists to let a recipient verify the file they received. */
const sha256Hex = Type.String({ pattern: "^[0-9a-f]{64}$" });

export const VISIT_REMINDER_CHANNELS = ["sms", "email"] as const;

export const VisitConfirmationRenderPayload = Type.Object({
  visitId: text,
  channel: Type.Union(VISIT_REMINDER_CHANNELS.map((c) => Type.Literal(c))),
  scheduledStartedAt: text,
});
export type VisitConfirmationRenderPayload = Static<typeof VisitConfirmationRenderPayload>;
export const assertVisitConfirmationRenderPayload = (p: unknown): VisitConfirmationRenderPayload =>
  assertRenderPayload("visit_confirmation", VisitConfirmationRenderPayload, p);

export const EvvVerificationRenderPayload = Type.Object({
  submissionId: text,
  visitId: text,
  stateCode: text,
  /** The aggregator's own transaction id; null until the aggregator assigned one. */
  aggregatorTransactionId: Type.Optional(nullableText),
  acceptedAt: text,
});
export type EvvVerificationRenderPayload = Static<typeof EvvVerificationRenderPayload>;
export const assertEvvVerificationRenderPayload = (p: unknown): EvvVerificationRenderPayload =>
  assertRenderPayload("evv_verification", EvvVerificationRenderPayload, p);

export const DsarBundleRenderPayload = Type.Object({
  /** The DSAR job id: the export reference printed on the sheet. */
  aggregateId: text,
  bundleSha256: sha256Hex,
  partTwoRedactionApplied: Type.Boolean(),
});
export type DsarBundleRenderPayload = Static<typeof DsarBundleRenderPayload>;
export const assertDsarBundleRenderPayload = (p: unknown): DsarBundleRenderPayload =>
  assertRenderPayload("dsar_bundle", DsarBundleRenderPayload, p);

export const TenantExportCoverRenderPayload = Type.Object({
  /** The tenant-export job id: the export reference printed on the letter. */
  aggregateId: text,
  bundleSha256: sha256Hex,
});
export type TenantExportCoverRenderPayload = Static<typeof TenantExportCoverRenderPayload>;
export const assertTenantExportCoverRenderPayload = (p: unknown): TenantExportCoverRenderPayload =>
  assertRenderPayload("tenant_export_cover_letter", TenantExportCoverRenderPayload, p);
