// apps/backend/src/modules/25-remittance/routes/m25-typebox.ts — M25 (§4.2) request-body TypeBox schemas.
// The route plugins validate POST/PATCH bodies against these; the §2.5 If-Match version + the
// Idempotency-Key are headers (handled in concurrency.ts), not body fields. Free-text reason/narrative
// fields carry the §4.1 min-length floors (audit-denylisted at the DB layer — never in the audit value).
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";

/** Validate + coerce a request body against a TypeBox schema; throw 400 VALIDATION_FAILED on mismatch. */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    const first = [...Value.Errors(schema, converted)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}

/** POST /remittance/lines/:id/manual-match — bind an unmatched line to a claim with a documented reason. */
export const ManualMatchRequestSchema = Type.Object({
  proposedClaimId: Type.String({ format: "uuid" }),
  reason: Type.String({ minLength: 20, maxLength: 500 }),
});

/** POST /remittance/adjustments/:id/override — re-classify a flagged/unmapped adjustment (step-up gated). */
export const AdjustmentOverrideRequestSchema = Type.Object({
  newPostAction: Type.Union([
    Type.Literal("auto_posted"),
    Type.Literal("ledger_recorded"),
    Type.Literal("denial_seeded"),
  ]),
  reason: Type.String({ minLength: 40, maxLength: 1000 }),
});

/** PATCH /denials/:id/assign — assign / reassign a denial case. */
export const DenialAssignRequestSchema = Type.Object({
  assigneeMembershipId: Type.String({ format: "uuid" }),
  reason: Type.Optional(Type.String({ maxLength: 500 })),
});

/** PATCH /denials/:id/escalate — in_progress → escalated. */
export const DenialEscalateRequestSchema = Type.Object({
  reason: Type.String({ minLength: 20, maxLength: 1000 }),
});

/** PATCH /denials/:id/resolve — → resolved (no appeal); reason ≥40. */
export const DenialResolveRequestSchema = Type.Object({
  reason: Type.String({ minLength: 40, maxLength: 1000 }),
});

/** POST /denials/:id/close-write-off — resolved → closed (written_off); step-up + reason ≥40. */
export const DenialCloseWriteOffRequestSchema = Type.Object({
  reason: Type.String({ minLength: 40, maxLength: 1000 }),
});

/** POST /denials/:id/reopen — closed → open; reason ≥40 (Billing Manager+). */
export const DenialReopenRequestSchema = Type.Object({
  reason: Type.String({ minLength: 40, maxLength: 1000 }),
});

/** POST /denials/:id/appeals — spawn an appeal case from a denial (tier inferred). */
export const AppealCreateRequestSchema = Type.Object({
  /** Optional override of the inferred tier (else redetermination, or next-tier from a prior decided appeal). */
  tier: Type.Optional(
    Type.Union([
      Type.Literal("redetermination"),
      Type.Literal("reconsideration"),
      Type.Literal("alj"),
      Type.Literal("council"),
      Type.Literal("federal_court"),
    ]),
  ),
});

/** PATCH /appeals/:id/attach — attach an M22 document id. */
export const AppealAttachRequestSchema = Type.Object({
  documentId: Type.String({ format: "uuid" }),
});

/** POST /appeals/:id/submit — draft → submitted; step-up + within-deadline. Narrative audit-denylisted. */
export const AppealSubmitRequestSchema = Type.Object({
  appealNarrative: Type.String({ minLength: 100, maxLength: 10000 }),
  attachedDocumentIds: Type.Array(Type.String({ format: "uuid" }), { minItems: 1 }),
});

/** POST /appeals/:id/decide — under_review → decided with a typed outcome; reason ≥40. */
export const AppealDecideRequestSchema = Type.Object({
  outcome: Type.Union([
    Type.Literal("favorable"),
    Type.Literal("partial"),
    Type.Literal("unfavorable"),
  ]),
  decidedAt: Type.String({ format: "date-time" }),
  macReferenceNumbers: Type.Optional(Type.Record(Type.String(), Type.String())),
  reason: Type.String({ minLength: 40, maxLength: 1000 }),
});

/** POST /appeals/:id/withdraw — (any non-closed) → withdrawn; reason ≥40. */
export const AppealWithdrawRequestSchema = Type.Object({
  reason: Type.String({ minLength: 40, maxLength: 1000 }),
});

/** PATCH /taxonomy/overlays/:carc — edit the tenant overlay (category intentionally absent — M25-F09). */
export const TaxonomyOverlayPatchSchema = Type.Object({
  rarcCode: Type.Optional(Type.String({ maxLength: 8 })),
  plainLanguageOverride: Type.Optional(Type.String({ maxLength: 500 })),
  suggestedAction: Type.String({ minLength: 10, maxLength: 1000 }),
  ownerRole: Type.Union([
    Type.Literal("billing_specialist"),
    Type.Literal("billing_manager"),
    Type.Literal("clinical_records"),
    Type.Literal("compliance_officer"),
    Type.Literal("md_or_np"),
  ]),
  severity: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("critical")]),
});
