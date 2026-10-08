// @wardenx/cap-management — the nine outbox-event names (§4.10) + their TypeBox payload shapes. The backend
// events-by-m26.ts assembles the platform `ModuleEventContribution` from these in P3 (the M27 precedent); the
// dispatcher validates each `m26.cap.*` publish against the matching payload schema inside the mutation
// transaction (transactional outbox). Names use the `m26.<resource=cap>.<verb>` form (no version suffix — the
// M27/M30/M33 catalog convention supersedes the spec's `.v1` proposal). No PHI beyond patient-id pointers.
import { type Static, Type } from "@sinclair/typebox";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const cents = Type.Integer();

export const M26_EVENT_NAMES = [
  "m26.cap.accrual_recorded",
  "m26.cap.projection_updated",
  "m26.cap.threshold_crossed",
  "m26.cap.year_opened",
  "m26.cap.year_closing",
  "m26.cap.year_closed",
  "m26.cap.settlement_proposed",
  "m26.cap.settlement_finalized",
  "m26.cap.psr_variance_raised",
] as const;

export type M26EventName = (typeof M26_EVENT_NAMES)[number];

export const AccrualRecordedPayload = Type.Object({
  organizationId: id,
  capPeriodId: id,
  patientId: id,
  accrualLineId: id,
  paidAmountCents: cents,
  postingDate: isoInstant,
});

export const ProjectionUpdatedPayload = Type.Object({
  organizationId: id,
  capPeriodId: id,
  scope: Type.Union([
    Type.Literal("agency_aggregate"),
    Type.Literal("patient_aggregate"),
    Type.Literal("inpatient"),
  ]),
  snapshotId: id,
  band: Type.String({ minLength: 1 }),
  computedAt: isoInstant,
});

export const ThresholdCrossedPayload = Type.Object({
  organizationId: id,
  capPeriodId: id,
  scope: Type.String({ minLength: 1 }),
  patientId: Type.Optional(Type.Union([id, Type.Null()])),
  bandFrom: Type.String({ minLength: 1 }),
  bandTo: Type.String({ minLength: 1 }),
  eventId: id,
  // GAP-040 — the figures the M36 alert consumer renders, so it needs no M26 read. All optional: events
  // published before these fields existed still validate.
  capYear: Type.Optional(Type.String({ pattern: "^FY\\d{4}$" })),
  pctOfCap: Type.Optional(Type.Number()),
  paidYtdCents: Type.Optional(cents),
  capAmountCents: Type.Optional(cents),
});

export const YearOpenedPayload = Type.Object({
  organizationId: id,
  capPeriodId: id,
  capYear: Type.String({ pattern: "^FY\\d{4}$" }),
  methodologyHint: Type.Optional(
    Type.Union([Type.Literal("streamlined"), Type.Literal("proportional"), Type.Null()]),
  ),
});

export const YearClosingPayload = Type.Object({
  organizationId: id,
  capPeriodId: id,
  capYear: Type.String({ pattern: "^FY\\d{4}$" }),
  transitionsToSettlement: Type.Boolean(),
});

export const YearClosedPayload = Type.Object({
  organizationId: id,
  capPeriodId: id,
  capYear: Type.String({ pattern: "^FY\\d{4}$" }),
  finalSettlementId: Type.Optional(Type.Union([id, Type.Null()])),
});

export const SettlementProposedPayload = Type.Object({
  organizationId: id,
  capPeriodId: id,
  settlementId: id,
  direction: Type.String({ minLength: 1 }),
  varianceAmountCents: cents,
});

export const SettlementFinalizedPayload = Type.Object({
  organizationId: id,
  capPeriodId: id,
  settlementId: id,
  finalizedAt: isoInstant,
  finalizedBy: id,
});

export const PsrVarianceRaisedPayload = Type.Object({
  organizationId: id,
  capPeriodId: id,
  importId: id,
  totalVarianceCents: cents,
  lineCount: Type.Integer(),
});

/** Event name → payload schema (the backend dispatcher validates publishes against this). */
export const M26_EVENT_PAYLOADS = {
  "m26.cap.accrual_recorded": AccrualRecordedPayload,
  "m26.cap.projection_updated": ProjectionUpdatedPayload,
  "m26.cap.threshold_crossed": ThresholdCrossedPayload,
  "m26.cap.year_opened": YearOpenedPayload,
  "m26.cap.year_closing": YearClosingPayload,
  "m26.cap.year_closed": YearClosedPayload,
  "m26.cap.settlement_proposed": SettlementProposedPayload,
  "m26.cap.settlement_finalized": SettlementFinalizedPayload,
  "m26.cap.psr_variance_raised": PsrVarianceRaisedPayload,
} as const satisfies Record<M26EventName, unknown>;

export type AccrualRecorded = Static<typeof AccrualRecordedPayload>;
export type ThresholdCrossed = Static<typeof ThresholdCrossedPayload>;
export type SettlementFinalized = Static<typeof SettlementFinalizedPayload>;
