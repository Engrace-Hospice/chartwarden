// @wardenx/cap-management — the §4.2 request/response TypeBox contracts (the OpenAPI shapes the backend
// routes bind in P3). Monetary fields cross the wire as integer cents; percentages as numbers. The §4.2 spec
// wrote some money fields as numeric strings — the canonical posture here is integer cents (the schema is
// BIGINT cents, §2.3), with the seam read-views (seams.ts) doing the cents-as-string conversion for
// cross-module consumers that must not parse to a lossy float.
import { type Static, Type } from "@sinclair/typebox";

const Uuid = Type.String({ format: "uuid" });
const IsoDate = Type.String({ format: "date" });
const IsoInstant = Type.String({ format: "date-time" });
const CapYear = Type.String({ pattern: "^FY\\d{4}$" });
const Cents = Type.Integer();

export const Methodology = Type.Union([Type.Literal("streamlined"), Type.Literal("proportional")]);
export const PeriodStatus = Type.Union([
  Type.Literal("open"),
  Type.Literal("active"),
  Type.Literal("in_settlement"),
  Type.Literal("settled"),
  Type.Literal("reopened"),
]);

// ── cap-period ───────────────────────────────────────────────────────────────────────────────────
export const CapPeriodDto = Type.Object({
  id: Uuid,
  capYear: CapYear,
  ccn: Type.String(),
  startDate: IsoDate,
  endDate: IsoDate,
  status: PeriodStatus,
  methodology: Type.Optional(Type.Union([Methodology, Type.Null()])),
  methodologyLockedAt: Type.Optional(Type.Union([IsoInstant, Type.Null()])),
  graceWindowDays: Type.Integer({ minimum: 0, maximum: 90 }),
  aggregateCapAmountCents: Cents,
  inpatientCapPct: Type.Number(),
  openedAt: IsoInstant,
});
export type CapPeriodDto = Static<typeof CapPeriodDto>;

export const OpenCapPeriodRequest = Type.Object({
  capYear: CapYear,
  methodology: Type.Optional(Methodology),
  graceWindowDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 90, default: 30 })),
});
export type OpenCapPeriodRequest = Static<typeof OpenCapPeriodRequest>;

export const LockMethodologyRequest = Type.Object({
  methodology: Methodology,
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  stepUpAssertionId: Uuid,
});

export const CloseCapPeriodRequest = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const ReopenCapPeriodRequest = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  stepUpAssertionId: Uuid,
});

// ── projection ───────────────────────────────────────────────────────────────────────────────────
export const ProjectionScope = Type.Union([
  Type.Literal("agency_aggregate"),
  Type.Literal("patient_aggregate"),
  Type.Literal("inpatient"),
]);

export const ProjectionSnapshotDto = Type.Object({
  id: Uuid,
  capPeriodId: Uuid,
  scope: ProjectionScope,
  patientId: Type.Optional(Type.Union([Uuid, Type.Null()])),
  methodology: Methodology,
  paidYtdCents: Cents,
  outstandingBilledCents: Cents,
  projectedYearEndCents: Cents,
  capAmountCents: Type.Union([Cents, Type.Null()]),
  pctOfCap: Type.Number(),
  alertBand: Type.String(),
  beneficiaryCount: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  computedAt: IsoInstant,
  computedBy: Type.Union([
    Type.Literal("nightly_batch"),
    Type.Literal("remittance_trigger"),
    Type.Literal("manual_recompute"),
  ]),
});
export type ProjectionSnapshotDto = Static<typeof ProjectionSnapshotDto>;

export const InpatientProjectionDto = Type.Object({
  capPeriodId: Uuid,
  inpatientDayCount: Type.Integer({ minimum: 0 }),
  totalDayCount: Type.Integer({ minimum: 0 }),
  utilizationPct: Type.Number({ minimum: 0 }),
  band: Type.String(),
  computedAt: IsoInstant,
});

export const RecomputeRequest = Type.Object({
  patientId: Type.Optional(Uuid), // omit for an agency-wide recompute
});

// ── threshold events ─────────────────────────────────────────────────────────────────────────────
export const AcknowledgeEventRequest = Type.Object({
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
});

// ── PS&R ─────────────────────────────────────────────────────────────────────────────────────────
export const MacRegion = Type.Union([
  Type.Literal("ngs"),
  Type.Literal("cgs"),
  Type.Literal("palmetto"),
  Type.Literal("wps"),
  Type.Literal("noridian"),
  Type.Literal("first_coast"),
  Type.Literal("novitas"),
]);

export const PsrImportRequest = Type.Object({
  macRegion: MacRegion,
  psrPeriodFrom: IsoDate,
  psrPeriodTo: IsoDate,
  fileBase64: Type.String({ minLength: 1 }), // the CSV payload; stored DEK-encrypted (§3.3)
});

export const ResolveVarianceRequest = Type.Object({
  varianceReason: Type.Union([
    Type.Literal("timing"),
    Type.Literal("psr_correction"),
    Type.Literal("our_correction"),
    Type.Literal("mbi_mismatch"),
    Type.Literal("data_quality"),
    Type.Literal("unknown"),
  ]),
  resolutionNotes: Type.String({ minLength: 20, maxLength: 2000 }),
});

// ── settlement ───────────────────────────────────────────────────────────────────────────────────
export const SettlementDirection = Type.Union([
  Type.Literal("overpayment_owed_to_cms"),
  Type.Literal("underpayment_owed_to_provider"),
  Type.Literal("balanced"),
]);

export const SettlementDto = Type.Object({
  id: Uuid,
  capPeriodId: Uuid,
  status: Type.Union([Type.Literal("proposed"), Type.Literal("reviewed"), Type.Literal("final")]),
  paidTotalCents: Cents,
  beneficiaryCount: Type.Integer(),
  aggregateCapAmountCents: Cents,
  aggregateOverageCents: Cents,
  direction: SettlementDirection,
  inpatientTotalDays: Type.Integer(),
  inpatientOverageDays: Type.Integer(),
  inpatientOverageCents: Cents,
  proposedAt: IsoInstant,
  finalizedAt: Type.Optional(Type.Union([IsoInstant, Type.Null()])),
});
export type SettlementDto = Static<typeof SettlementDto>;

export const FinalizeSettlementRequest = Type.Object({
  attestation: Type.String({ minLength: 20, maxLength: 2000 }),
  stepUpAssertionId: Uuid,
});

// ── platform constants ───────────────────────────────────────────────────────────────────────────
export const PublishConstantRequest = Type.Object({
  capYear: CapYear,
  aggregateCapAmountCents: Cents,
  inpatientCapPct: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.2 })),
  sourceUrl: Type.Optional(Type.String()),
});

export const AmendConstantRequest = Type.Object({
  aggregateCapAmountCents: Cents,
  sourceUrl: Type.Optional(Type.String()),
});
