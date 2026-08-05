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

/**
 * POST /internal/remittance/advices (route #32, WX-PR-012, system-principal only) — receive a raw 835
 * ALREADY staged in MinIO by the (unbuilt) clearinghouse-pull transport; `rawEdi` is used only to derive
 * the ISA/ST dedup key locally, never persisted verbatim.
 */
export const ReceiveAdviceRequestSchema = Type.Object({
  providerEntityId: Type.String({ format: "uuid" }),
  payerId: Type.String({ format: "uuid" }),
  payerKind: Type.Union([
    Type.Literal("medicare"),
    Type.Literal("medicaid"),
    Type.Literal("commercial"),
  ]),
  minioObjectKey: Type.String({ minLength: 1 }),
  fileSha256: Type.String({ minLength: 64, maxLength: 64 }),
  rawEdi: Type.String({ minLength: 1 }),
});

/** POST /internal/remittance/advices — the 202/409/422 receive outcome (route #32, WX-PR-012). */
export const ReceiveAdviceResponseSchema = Type.Union([
  Type.Object({ outcome: Type.Literal("queued"), adviceId: Type.String() }),
  Type.Object({ outcome: Type.Literal("duplicate"), existingAdviceId: Type.String() }),
  Type.Object({ outcome: Type.Literal("malformed"), reason: Type.String() }),
]);

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

// ── §4.1 RESPONSE DTOs ─────────────────────────────────────────────────────────────────────────
//
// The four cursor-paginated reads the M25 web screens call. Without these the generated client types
// every M25 response as `content?: never`, so the screens cast through
// `res.data as unknown as Page<DenialRow>` with a hand-maintained row shape that can drift from the
// server silently. These mirror `read-service.ts`'s view interfaces — that file is the contract, this
// is its wire projection.
//
// Money is a decimal STRING on the wire (the ledger columns are `numeric`), never a float: rounding a
// remittance amount through an IEEE double is exactly the bug the string avoids.

const nullableString = () => Type.Union([Type.String(), Type.Null()]);

/** A cursor page (§4.12 — opaque cursor, never an offset). */
const pageOf = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    nextCursor: nullableString(),
  });

/** `read-service.ts` → `DenialWorklistItem`. */
export const DenialWorklistItemSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  providerEntityId: Type.String({ format: "uuid" }),
  claimId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  carcCode: Type.String(),
  rarcCode: nullableString(),
  category: Type.String(),
  source: Type.String(),
  state: Type.String(),
  assigneeMembershipId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  openedAt: Type.String({ format: "date-time" }),
  agingBucketDays: Type.Integer(),
  agingBucketLabel: Type.String(),
  dollarValue: Type.String({ description: "Decimal string (numeric column) — never a float" }),
  taxonomyStatus: Type.String(),
});
export const DenialWorklistPageSchema = pageOf(DenialWorklistItemSchema);

/** `read-service.ts` → `AppealSummary`. */
export const AppealSummarySchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  denialCaseId: Type.String({ format: "uuid" }),
  claimId: Type.String({ format: "uuid" }),
  tier: Type.String(),
  state: Type.String(),
  decisionOutcome: nullableString(),
  tierDeadlineAt: Type.String({ format: "date-time" }),
  version: Type.Integer(),
});
export const AppealSummaryPageSchema = pageOf(AppealSummarySchema);

/** `read-service.ts` → `RemittanceAdviceSummary`. */
export const RemittanceAdviceSummarySchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  providerEntityId: Type.String({ format: "uuid" }),
  payerId: Type.String(),
  payerKind: Type.String(),
  paymentMethod: Type.String(),
  totalPaymentAmount: Type.String({ description: "Decimal string — never a float" }),
  parseStatus: Type.String(),
  receivedAt: Type.String({ format: "date-time" }),
});
export const RemittanceAdviceSummaryPageSchema = pageOf(RemittanceAdviceSummarySchema);

/** `read-service.ts` → `RemittanceLineSummary` (the unmatched-lines worklist reads the same shape). */
export const RemittanceLineSummarySchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  remittanceAdviceId: Type.String({ format: "uuid" }),
  claimId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  clp02StatusCode: Type.Integer(),
  clp03TotalChargeAmount: Type.String({ description: "Decimal string — never a float" }),
  clp04TotalPaymentAmount: Type.String({ description: "Decimal string — never a float" }),
  clp05PatientResponsibilityAmount: Type.String({ description: "Decimal string — never a float" }),
  matchState: Type.String(),
  matchStrategy: nullableString(),
  matchConfidence: Type.Union([Type.Number(), Type.Null()]),
  receivedAt: Type.String({ format: "date-time" }),
});
export const RemittanceLineSummaryPageSchema = pageOf(RemittanceLineSummarySchema);

/** The §4.12 cursor-page query every M25 list read accepts. */
export const M25ListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ minLength: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
});

// ── §4.1 RESPONSE DTOs (F0 enrichment, part 2) ───────────────────────────────────────────────────
//
// The remaining M25 read/detail/mutation responses the earlier DTO block did not cover: the singular
// detail GETs (advice/line/denial/appeal), the merged taxonomy view, the two internal seam reads, and
// the versioned mutation result every write route returns. Each is pinned to its `read-service.ts` /
// `write-service.ts` view by the compile-time `Conforms` alias below, so a view field added or renamed
// breaks `bun run build` rather than silently drifting from the generated client. Money stays a decimal
// STRING on the wire (numeric columns), never an IEEE float.
import type {
  AppealDetail as ServiceAppealDetail,
  AppealEventView as ServiceAppealEventView,
  DenialMetricsView as ServiceDenialMetricsView,
  PrLedgerRow as ServicePrLedgerRow,
  RemittanceAdviceSummary as ServiceRemittanceAdviceSummary,
  TaxonomyMergedView as ServiceTaxonomyMergedView,
} from "./read-service";
import type { VersionedResult as ServiceVersionedResult } from "./write-service";

/** `write-service.ts` → `VersionedResult`: the `{ id, version }` every mutation returns for the next If-Match. */
export const VersionedResultSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  version: Type.Integer(),
});

/** One row of the appeal timeline (`read-service.ts` → `AppealEventView`). */
export const AppealEventViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  eventKind: Type.String(),
  occurredAt: Type.String({ format: "date-time" }),
});

/** `read-service.ts` → `AppealDetail` (the appeal summary + packet/dates + event timeline). */
export const AppealDetailSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  denialCaseId: Type.String({ format: "uuid" }),
  claimId: Type.String({ format: "uuid" }),
  tier: Type.String(),
  state: Type.String(),
  decisionOutcome: nullableString(),
  tierDeadlineAt: Type.String({ format: "date-time" }),
  version: Type.Integer(),
  appealPacketDocumentId: nullableString(),
  submittedAt: nullableString(),
  decidedAt: nullableString(),
  events: Type.Array(AppealEventViewSchema),
});

/** `read-service.ts` → `TaxonomyMergedView` (the M38 regulatory floor + the tenant overlay merge). */
export const TaxonomyMergedViewSchema = Type.Object({
  carcCode: Type.String(),
  rarcCode: nullableString(),
  category: Type.String(),
  plainLanguage: Type.String(),
  suggestedAction: nullableString(),
  ownerRole: nullableString(),
  severity: nullableString(),
  hasOverlay: Type.Boolean(),
  overlayVersion: Type.Union([Type.Integer(), Type.Null()]),
});

/** `read-service.ts` → `DenialMetricsView` (the DenialMetricsProvider seam projection). */
export const DenialMetricsViewSchema = Type.Object({
  agingBucketCounts: Type.Object({
    "0-7": Type.Integer(),
    "8-15": Type.Integer(),
    "16-30": Type.Integer(),
    "31-60": Type.Integer(),
    "61-90": Type.Integer(),
    "91+": Type.Integer(),
  }),
  openCount: Type.Integer(),
  totalDollarOpen: Type.String({ description: "Decimal string — never a float" }),
});

/** `read-service.ts` → `PrLedgerRow` (one patient-responsibility ledger row). */
export const PrLedgerRowSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  patientId: Type.String({ format: "uuid" }),
  prAmount: Type.String({ description: "Decimal string — never a float" }),
  status: Type.String(),
  recordedAt: Type.String({ format: "date-time" }),
});

/** The §17 internal RemittanceReader seam envelope (`{ advice }`, nullable). */
export const RemittanceAdviceReaderResponseSchema = Type.Object({
  advice: Type.Union([RemittanceAdviceSummarySchema, Type.Null()]),
});

/** The §17 internal PatientResponsibilityReader seam envelope (`{ items }`, no cursor). */
export const PrLedgerItemsResponseSchema = Type.Object({
  items: Type.Array(PrLedgerRowSchema),
});

/** POST /remittance/advices/:id/replay — the 202 queue receipt (ad-hoc handler literal). */
export const ReplayQueuedResponseSchema = Type.Object({
  id: Type.String(),
  status: Type.Literal("queued"),
});

/** POST /remittance/lines/:id/manual-match — the ad-hoc handler literal. */
export const ManualMatchResponseSchema = Type.Object({
  id: Type.String(),
  matchState: Type.Literal("manual_matched"),
});

/** POST /remittance/adjustments/:id/override — the ad-hoc handler literal (echoes the new post-action). */
export const AdjustmentOverrideResponseSchema = Type.Object({
  id: Type.String(),
  postAction: Type.Union([
    Type.Literal("auto_posted"),
    Type.Literal("ledger_recorded"),
    Type.Literal("denial_seeded"),
  ]),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _VersionedResult = Conforms<Static<typeof VersionedResultSchema>, ServiceVersionedResult>;
type _AppealEventView = Conforms<Static<typeof AppealEventViewSchema>, ServiceAppealEventView>;
type _AppealDetail = Conforms<Static<typeof AppealDetailSchema>, ServiceAppealDetail>;
type _TaxonomyMergedView = Conforms<
  Static<typeof TaxonomyMergedViewSchema>,
  ServiceTaxonomyMergedView
>;
type _DenialMetricsView = Conforms<
  Static<typeof DenialMetricsViewSchema>,
  ServiceDenialMetricsView
>;
type _PrLedgerRow = Conforms<Static<typeof PrLedgerRowSchema>, ServicePrLedgerRow>;
type _RemittanceAdviceReader = Conforms<
  Static<typeof RemittanceAdviceReaderResponseSchema>,
  { readonly advice: ServiceRemittanceAdviceSummary | null }
>;
type _PrLedgerItems = Conforms<
  Static<typeof PrLedgerItemsResponseSchema>,
  { readonly items: readonly ServicePrLedgerRow[] }
>;
