// apps/backend/src/modules/30-quality/routes/quality-typebox.ts — M30 (§4.2) request schemas.
//
// TypeBox path-param / query / body schemas for the 47 §4.1 routes (quality measures, CAHPS, QAPI, SRA,
// incidents, mortality, CoP compliance, infection, risk register) + the `parse(...)` helper. Named
// `quality-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox
// import for a Drizzle one (the M22 `documents-typebox` / M33 `reporting-typebox` precedent). Validation
// runs through TypeBox `Value` → M1's VALIDATION_FAILED envelope (the same `parse(...)` the M22/M33
// routes use). Org/actor binding is ALWAYS server-side (request.context) — no body/query carries an org
// id, a reporter/owner/cosigner membership id is supplied only by the route from the actor, never read
// off the wire except for the explicit co-sign role identities the closer attests to.
//
// VOCAB NOTE: the string-literal unions below mirror the FROZEN `@wardenx/db` pgEnum value lists
// (packages/db/src/schema/quality/*), which are authoritative over the spec §4.2 TypeBox examples where
// they differ — incident severity is `minor|moderate|severe|critical` (not the spec's
// `mild|…|sentinel`) and the measure period kind is `rolling_12m_to_quarter|…|cap_year_overlay` (not the
// spec's `rolling_12mo|…|cms_reference_period`). Architecture/schema wins on conflict.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set("date", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
}

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));
const uuid = () => Type.String({ format: "uuid" });
const isoInstant = () => Type.String({ format: "date-time" });
const isoDate = () => Type.String({ format: "date" });

// ── §3 vocab mirrors (string-literal unions; canonical pgEnums live in @wardenx/db, see header note) ───
const MEASURE_DOMAIN = ["hci", "hvldl", "hope", "cahps", "operational"] as const;
const RECOMPUTE_DOMAIN = ["hci", "hvldl", "hope", "cahps"] as const;
const MEASURE_PERIOD_KIND = [
  "rolling_12m_to_quarter",
  "calendar_quarter",
  "calendar_year",
  "cap_year_overlay",
] as const;
const INCIDENT_KIND = [
  "fall",
  "medication_error",
  "complaint",
  "allegation_of_abuse",
  "exposure_event",
  "other_safety_event",
] as const;
const INCIDENT_SEVERITY = ["minor", "moderate", "severe", "critical"] as const;
const INCIDENT_STATE = [
  "draft",
  "submitted",
  "triaged",
  "under_investigation",
  "resolved",
  "closed_followup_complete",
  "reopened",
] as const;
const QAPI_PROJECT_PHASE = [
  "proposed",
  "active",
  "corrective_action",
  "completed",
  "abandoned",
] as const;
const SRA_FINDING_DISPOSITION = [
  "open",
  "accepted",
  "remediating",
  "remediated",
  "transferred",
] as const;
const SRA_REMEDIATION_STATUS = ["planned", "in_progress", "completed", "deferred"] as const;
const COP_STATUS = ["compliant", "at_risk", "deficient"] as const;
const MORTALITY_STATUS = ["created", "in_progress", "completed"] as const;
const OUTBREAK_STATUS = ["open", "notified", "contained", "resolved"] as const;
const RISK_SOURCE = ["incident", "qapi", "sra", "infection", "cop", "measure"] as const;
const RISK_SEVERITY = ["critical", "high", "medium", "low"] as const;
const PRIORITY = ["normal", "high"] as const;
const MEASURE_BAND_COLOR = ["green", "yellow", "red", "insufficient_n"] as const;
const SRA_CYCLE_STATUS = ["chartered", "in_progress", "review", "closed", "reopened"] as const;
const SRA_RISK_BAND = ["critical", "high", "medium", "low"] as const;
const QAPI_PIP_PHASE = [
  "chartering",
  "root_cause_analysis",
  "intervention_in_progress",
  "measurement",
  "concluded",
  "suspended",
] as const;
const QAPI_PROGRAM_STATUS = ["active", "superseded"] as const;
const CAHPS_EXPORT_STATUS = ["queued", "running", "completed", "failed"] as const;
const RECOMPUTE_JOB_STATE = ["waiting", "active", "delayed", "completed", "failed"] as const;
const THRESHOLD_DIRECTION = ["min", "max"] as const;

// ── shared sub-schemas ────────────────────────────────────────────────────────────────────────────────
const GovernanceMemberSchema = Type.Object({
  role: Type.String({ minLength: 1, maxLength: 120 }),
  membershipId: uuid(),
});
const CapActionSchema = Type.Object({
  action: Type.String({ minLength: 1, maxLength: 2000 }),
  ownerMembershipId: uuid(),
  dueAt: isoDate(),
});
const PipCosignSchema = Type.Object({
  qapiCoordinatorMembershipId: uuid(),
  medicalDirectorMembershipId: uuid(),
});
const SraCosignSchema = Type.Object({
  securityOfficerMembershipId: uuid(),
  complianceOfficerMembershipId: uuid(),
});
const DimensionPayload = Type.Record(Type.String(), Type.Unknown());

// ── cursor / keyset page query (§4.1.2 — opaque cursor + clamp-to-100 limit) ───────────────────────────
const PageQuery = {
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
};

// ── path params ────────────────────────────────────────────────────────────────────────────────────────
export const MeasureIdParamsSchema = Type.Object({
  measureId: Type.String({ minLength: 1, maxLength: 128 }),
});
export const MeasureValueParamsSchema = Type.Object({
  measureId: Type.String({ minLength: 1, maxLength: 128 }),
  valueId: uuid(),
});
export const SampleIdParamsSchema = Type.Object({ sampleId: uuid() });
export const ExportIdParamsSchema = Type.Object({ exportId: uuid() });
export const ProgramIdParamsSchema = Type.Object({ programId: uuid() });
export const IndicatorIdParamsSchema = Type.Object({ indicatorId: uuid() });
export const ProjectIdParamsSchema = Type.Object({ projectId: uuid() });
export const PipIdParamsSchema = Type.Object({ pipId: uuid() });
export const CycleIdParamsSchema = Type.Object({ cycleId: uuid() });
export const FindingIdParamsSchema = Type.Object({ findingId: uuid() });
export const RemediationIdParamsSchema = Type.Object({ remediationId: uuid() });
export const IncidentIdParamsSchema = Type.Object({ incidentId: uuid() });
export const ReviewIdParamsSchema = Type.Object({ reviewId: uuid() });
export const CitationIdParamsSchema = Type.Object({ citationId: uuid() });
export const CaseIdParamsSchema = Type.Object({ caseId: uuid() });

// ── query schemas ───────────────────────────────────────────────────────────────────────────────────────
// Quality measures
export const MeasureListQuerySchema = Type.Object({
  domain: Type.Optional(lit(MEASURE_DOMAIN)),
  ...PageQuery,
});
export const MeasureValuesQuerySchema = Type.Object({
  windowStart: Type.Optional(isoDate()),
  windowEnd: Type.Optional(isoDate()),
});
// CAHPS
export const CahpsDecedentListQuerySchema = Type.Object({
  samplePeriodStart: Type.Optional(isoDate()),
  samplePeriodEnd: Type.Optional(isoDate()),
  eligibleOnly: Type.Optional(Type.Boolean()),
  ...PageQuery,
});
export const CahpsResultListQuerySchema = Type.Object({
  reportingPeriodStart: Type.Optional(isoDate()),
  reportingPeriodEnd: Type.Optional(isoDate()),
  measureId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  ...PageQuery,
});
// QAPI
export const QapiProgramListQuerySchema = Type.Object(PageQuery);
export const QapiIndicatorListQuerySchema = Type.Object(PageQuery);
export const QapiProjectListQuerySchema = Type.Object({
  phase: Type.Optional(
    Type.Array(lit(QAPI_PROJECT_PHASE), { maxItems: QAPI_PROJECT_PHASE.length }),
  ),
  programId: Type.Optional(uuid()),
  ...PageQuery,
});
export const QapiPipListQuerySchema = Type.Object(PageQuery);
export const QapiGovernanceListQuerySchema = Type.Object(PageQuery);
// SRA
export const SraCycleListQuerySchema = Type.Object(PageQuery);
// Incidents (PHI — cursor pagination, §4.1.2)
export const IncidentListQuerySchema = Type.Object({
  kind: Type.Optional(Type.Array(lit(INCIDENT_KIND), { maxItems: INCIDENT_KIND.length })),
  state: Type.Optional(Type.Array(lit(INCIDENT_STATE), { maxItems: INCIDENT_STATE.length })),
  severity: Type.Optional(
    Type.Array(lit(INCIDENT_SEVERITY), { maxItems: INCIDENT_SEVERITY.length }),
  ),
  occurredAfter: Type.Optional(isoInstant()),
  occurredBefore: Type.Optional(isoInstant()),
  patientId: Type.Optional(uuid()),
  ...PageQuery,
});
export const AbuseAllegationListQuerySchema = Type.Object(PageQuery);
// Mortality (PHI)
export const MortalityListQuerySchema = Type.Object({
  status: Type.Optional(lit(MORTALITY_STATUS)),
  patientId: Type.Optional(uuid()),
  ...PageQuery,
});
// CoP compliance
export const CopCitationListQuerySchema = Type.Object(PageQuery);
// Infection (events are PHI)
export const InfectionEventListQuerySchema = Type.Object({
  pathogen: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  patientId: Type.Optional(uuid()),
  observedAfter: Type.Optional(isoInstant()),
  observedBefore: Type.Optional(isoInstant()),
  ...PageQuery,
});
export const InfectionOutbreakListQuerySchema = Type.Object({
  status: Type.Optional(lit(OUTBREAK_STATUS)),
  pathogen: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  ...PageQuery,
});
// Risk register
export const RiskRegisterListQuerySchema = Type.Object({
  source: Type.Optional(lit(RISK_SOURCE)),
  severity: Type.Optional(lit(RISK_SEVERITY)),
  ...PageQuery,
});

// ── body schemas ────────────────────────────────────────────────────────────────────────────────────────
// Quality measures (R-04)
const RecomputeScopeSchema = Type.Union([
  Type.Object({ kind: Type.Literal("all") }),
  Type.Object({
    kind: Type.Literal("measure"),
    measureId: Type.String({ minLength: 1, maxLength: 128 }),
  }),
  Type.Object({ kind: Type.Literal("domain"), domain: lit(RECOMPUTE_DOMAIN) }),
]);
export const EnqueueRecomputeBodySchema = Type.Object({
  scope: RecomputeScopeSchema,
  reason: Type.String({ minLength: 8, maxLength: 240 }),
  priority: Type.Optional(lit(PRIORITY)),
});

// CAHPS (R-11, R-13, R-14, R-16)
export const BindCahpsVendorBodySchema = Type.Object({
  vendorAdapterId: Type.String({ minLength: 1, maxLength: 120 }),
  effectiveFrom: isoDate(),
});
export const ExcludeCahpsDecedentBodySchema = Type.Object({
  exclusionReason: Type.String({ minLength: 4, maxLength: 500 }),
});
export const CreateCahpsExportBodySchema = Type.Object({
  samplePeriodStart: isoDate(),
  samplePeriodEnd: isoDate(),
});
export const IngestCahpsResultsBodySchema = Type.Object({
  vendorAdapterId: Type.String({ minLength: 1, maxLength: 120 }),
  reportingPeriodStart: isoDate(),
  reportingPeriodEnd: isoDate(),
  results: Type.Array(
    Type.Object({
      measureId: Type.String({ minLength: 1, maxLength: 128 }),
      topBoxPercent: Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]),
      respondentCount: Type.Integer({ minimum: 0 }),
    }),
    { minItems: 1 },
  ),
  payloadHash: Type.String({ minLength: 1, maxLength: 128 }),
});

// QAPI (R-21, R-22, R-24, R-25, R-27, R-28, R-30, R-31, R-32)
export const AdoptQapiProgramBodySchema = Type.Object({
  planYear: Type.Integer({ minimum: 2000, maximum: 2100 }),
  governanceComposition: Type.Array(GovernanceMemberSchema, { minItems: 1 }),
});
export const UpdateQapiGovernanceBodySchema = Type.Object({
  governanceComposition: Type.Array(GovernanceMemberSchema, { minItems: 1 }),
});
export const CreateQapiIndicatorBodySchema = Type.Object({
  qapiProgramId: uuid(),
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  measureId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  thresholdDirection: lit(["min", "max"] as const),
  thresholdValue: Type.Number(),
  dataPath: Type.String({ minLength: 1, maxLength: 200 }),
});
export const UpdateQapiIndicatorBodySchema = Type.Object({
  thresholdValue: Type.Optional(Type.Number()),
  thresholdDirection: Type.Optional(lit(["min", "max"] as const)),
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});
export const CharterQapiProjectBodySchema = Type.Object({
  qapiProgramId: uuid(),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  indicatorId: Type.Optional(uuid()),
  charterNarrative: Type.String({ minLength: 1, maxLength: 8000 }),
});
export const UpdateQapiProjectBodySchema = Type.Object({
  phase: Type.Optional(lit(QAPI_PROJECT_PHASE)),
  interventions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }))),
  ledByMembershipId: Type.Optional(uuid()),
});
export const AddQapiPipBodySchema = Type.Object({
  charterText: Type.String({ minLength: 1, maxLength: 8000 }),
});
export const CloseQapiPipBodySchema = Type.Object({
  conclusionText: Type.String({ minLength: 1, maxLength: 8000 }),
  outcome: Type.String({ minLength: 1, maxLength: 500 }),
  cosign: PipCosignSchema,
});
export const RecordQapiGovernanceBodySchema = Type.Object({
  qapiProgramId: uuid(),
  meetingAt: isoInstant(),
  summary: Type.String({ minLength: 1, maxLength: 16000 }),
  attendees: Type.Array(GovernanceMemberSchema, { minItems: 1 }),
});

// SRA (R-41, R-43, R-44, R-45, R-46, R-47)
export const OpenSraCycleBodySchema = Type.Object({
  cycleYear: Type.Integer({ minimum: 2000, maximum: 2100 }),
});
export const AddSraFindingBodySchema = Type.Object({
  findingNumber: Type.Integer({ minimum: 1 }),
  controlRef: Type.String({ minLength: 1, maxLength: 120 }),
  likelihood: Type.Integer({ minimum: 1, maximum: 5 }),
  impact: Type.Integer({ minimum: 1, maximum: 5 }),
  description: Type.String({ minLength: 1, maxLength: 8000 }),
});
export const UpdateSraFindingBodySchema = Type.Object({
  likelihood: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  impact: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  disposition: Type.Optional(lit(SRA_FINDING_DISPOSITION)),
});
export const PlanSraRemediationBodySchema = Type.Object({
  remediationNumber: Type.Integer({ minimum: 1 }),
  plan: Type.String({ minLength: 1, maxLength: 8000 }),
  ownerMembershipId: uuid(),
  dueAt: Type.Optional(isoDate()),
});
export const UpdateSraRemediationBodySchema = Type.Object({
  status: Type.Optional(lit(SRA_REMEDIATION_STATUS)),
  dueAt: Type.Optional(isoDate()),
});
export const CloseSraCycleBodySchema = Type.Object({
  cosign: SraCosignSchema,
});

// Incidents (R-51, R-53, R-55, R-56, R-57, R-58, R-60)
export const CreateIncidentBodySchema = Type.Object({
  kind: lit(INCIDENT_KIND),
  severity: lit(INCIDENT_SEVERITY),
  patientId: Type.Optional(uuid()),
  occurredAt: isoInstant(),
  // The kind-discriminated payload is validated against the per-kind §4.2 schema in the service layer.
  data: Type.Record(Type.String(), Type.Unknown()),
});
export const UpdateIncidentBodySchema = Type.Object({
  severity: Type.Optional(lit(INCIDENT_SEVERITY)),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  occurredAt: Type.Optional(isoInstant()),
});
export const TriageIncidentBodySchema = Type.Object({
  assignedToMembershipId: uuid(),
  severity: lit(INCIDENT_SEVERITY),
});
export const AddInvestigationNoteBodySchema = Type.Object({
  body: Type.String({ minLength: 1, maxLength: 16000 }),
});
export const OpenInvestigationBodySchema = Type.Object({
  rootCauseSummary: Type.String({ minLength: 40, maxLength: 8000 }),
  actions: Type.Array(CapActionSchema, { minItems: 1 }),
  verificationCriteria: Type.String({ minLength: 1, maxLength: 4000 }),
});
export const ResolveIncidentBodySchema = Type.Object({
  resolutionNote: Type.String({ minLength: 1, maxLength: 8000 }),
});
export const ReopenIncidentBodySchema = Type.Object({
  reopenReason: Type.String({ minLength: 1, maxLength: 4000 }),
});

// Mortality (R-72, R-73)
export const UpdateMortalityReviewBodySchema = Type.Object({
  dimensions: Type.Optional(
    Type.Object({
      clinical: Type.Optional(DimensionPayload),
      satisfaction: Type.Optional(DimensionPayload),
      compliance: Type.Optional(DimensionPayload),
    }),
  ),
  assignedToMembershipId: Type.Optional(uuid()),
});
export const CompleteMortalityReviewBodySchema = Type.Object({
  dimensions: Type.Object({
    clinical: DimensionPayload,
    satisfaction: DimensionPayload,
    compliance: DimensionPayload,
  }),
});

// CoP compliance (R-81, R-82)
export const UpdateCopCitationBodySchema = Type.Object({
  status: Type.Optional(lit(COP_STATUS)),
  evidencePointers: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }))),
});
export const ReviewCopCitationBodySchema = Type.Object({
  attestation: Type.String({ minLength: 1, maxLength: 4000 }),
});

// Infection (R-91, R-93)
export const RecordInfectionEventBodySchema = Type.Object({
  patientId: uuid(),
  pathogen: Type.String({ minLength: 1, maxLength: 200 }),
  bodySite: Type.String({ minLength: 1, maxLength: 200 }),
  observedAt: isoInstant(),
});
export const UpdateInfectionOutbreakBodySchema = Type.Object({
  status: lit(OUTBREAK_STATUS),
  resolutionNote: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
});

// ── parse helper ────────────────────────────────────────────────────────────────────────────────────────

/** Parse `raw` through `schema` → typed value, or throw M1's VALIDATION_FAILED envelope (M33 `parse`). */
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

// ── §4.1 RESPONSE DTOs ─────────────────────────────────────────────────────────────────────────
//
// The reads the M30 web screens call. Without these the generated client types every M30 response as
// `content?: never`, so a screen must cast through a hand-maintained row shape that drifts silently —
// the problem the M25 screens carried until their DTOs landed. These mirror `read-service.ts`'s view
// interfaces; that file is the contract, this is its wire projection.
//
// M30's list handlers return the `CursorPage` DIRECTLY (`{ items, nextCursor, hasMore }`), not wrapped in
// a `{ data }` envelope the way M39's do — the envelope is modelled here so no screen has to guess.

const m30Nullable = <T extends TSchema>(inner: T) => Type.Union([inner, Type.Null()]);

/** `concurrency.ts` → `CursorPage<T>` (§4.12 — opaque cursor, never an offset). */
const m30PageOf = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    nextCursor: m30Nullable(Type.String()),
    hasMore: Type.Boolean(),
  });

/** `read-service.ts` → `MeasureValueView`. The numerator/denominator PAIR is on the wire deliberately:
 *  a UI that showed only the rate could not distinguish a suppressed measure from a real 0%. */
export const MeasureValueViewSchema = Type.Object({
  valueId: Type.String(),
  organizationId: Type.String(),
  measureId: Type.String(),
  period: Type.Object({ kind: lit(MEASURE_PERIOD_KIND), start: Type.String(), end: Type.String() }),
  numerator: Type.Number(),
  denominator: Type.Number(),
  rate: m30Nullable(Type.Number()),
  thresholdMet: m30Nullable(Type.Boolean()),
  bandColor: lit(MEASURE_BAND_COLOR),
  computedAt: Type.String(),
  computeVersion: Type.String(),
  snapshotContentHash: Type.String(),
  supersededByValueId: m30Nullable(Type.String()),
});

/** `read-service.ts` → `MeasureSummaryView`. */
export const MeasureSummaryViewSchema = Type.Object({
  measureId: Type.String(),
  displayName: Type.String(),
  domain: lit(MEASURE_DOMAIN),
  latestValue: m30Nullable(MeasureValueViewSchema),
  fiscalYear: Type.Integer(),
});
export const MeasureListResponseSchema = m30PageOf(MeasureSummaryViewSchema);

/** `read-service.ts` → `IncidentSummaryView`. `patientId` is nullable — not every incident is clinical. */
export const IncidentSummaryViewSchema = Type.Object({
  incidentId: Type.String(),
  organizationId: Type.String(),
  kind: lit(INCIDENT_KIND),
  state: lit(INCIDENT_STATE),
  severity: lit(INCIDENT_SEVERITY),
  patientId: m30Nullable(Type.String()),
  occurredAt: Type.String(),
  reportedAt: Type.String(),
  reportedByMembershipId: Type.String(),
  assignedToMembershipId: m30Nullable(Type.String()),
});
export const IncidentListResponseSchema = m30PageOf(IncidentSummaryViewSchema);

/** `read-service.ts` → `QapiProjectView`. */
export const QapiProjectViewSchema = Type.Object({
  projectId: Type.String(),
  organizationId: Type.String(),
  qapiProgramId: Type.String(),
  title: Type.String(),
  phase: lit(QAPI_PROJECT_PHASE),
  indicatorId: m30Nullable(Type.String()),
  ledByMembershipId: m30Nullable(Type.String()),
  charteredAt: Type.String(),
  completedAt: m30Nullable(Type.String()),
});
export const QapiProjectListResponseSchema = m30PageOf(QapiProjectViewSchema);

/** `read-service.ts` → `CopCitationView` (the §1.2 CoP compliance posture). */
export const CopCitationViewSchema = Type.Object({
  citationId: Type.String(),
  organizationId: Type.String(),
  citationRef: Type.String(),
  displayName: Type.String(),
  status: lit(COP_STATUS),
  evidencePointers: Type.Array(Type.String()),
  lastReviewedAt: m30Nullable(Type.String()),
  nextReviewDueAt: m30Nullable(Type.String()),
});
export const CopCitationListResponseSchema = m30PageOf(CopCitationViewSchema);

// ── §4.1 RESPONSE DTOs, part 2 — the remaining 20 reads ────────────────────────────────────────
//
// The four above covered the reads the first two Quality screens call. These cover the rest, so no
// M30 GET publishes `content?: never` and no future screen has to invent a row shape to cast to.
//
// VOCAB RULE — EVERY vocabulary field is published CLOSED, through the `lit(...)` mirrors at the top
// of this file. Part 1 originally published the pgEnum-backed ones (`IncidentKind`, `CopStatus`,
// `SraCycleStatus`, `MeasurePeriodKind`, `MeasureBandColor`, `QapiProjectPhase`) as `Type.String()`,
// on the theory that a second literal list here is a second place to drift. The conformance aliases
// at the bottom of this file rejected that immediately, and correctly: `Type.String()` publishes a
// contract WIDER than what the service returns, so the generated client cannot narrow — a screen
// switching on `incident.state` gets `string` and no exhaustiveness checking, which is most of the
// value of publishing the read at all. The mirrors are the drift control (one `lit()` const per
// vocabulary, reused by request AND response schemas); widening the wire type is not.

/** `{ role, membershipId }` — the QAPI governance roster / attendee shape. */
const M30GovernanceMemberSchema = Type.Object({
  role: Type.String(),
  membershipId: Type.String(),
});

/** Free-form structured payloads (per-kind incident data, mortality dimensions, snapshot inputs). */
const m30Json = () => Type.Record(Type.String(), Type.Unknown());

// ── Measures (R-02, R-03, R-05) ───────────────────────────────────────────────────────────────

/** `read-service.ts` → `MeasureValueSeriesView`. NOT a page: the rolling window is the unit. */
export const MeasureValueSeriesResponseSchema = Type.Object({
  measureId: Type.String(),
  displayName: Type.String(),
  values: Type.Array(MeasureValueViewSchema),
});

/** `read-service.ts` → `MeasureValueSnapshotView` (D1 reproducibility; `quality.measure.audit`).
 *  The hashed-over inputs are published in full — a snapshot a caller cannot inspect cannot be
 *  used to reproduce the value, which is the whole point of the row. */
export const MeasureValueSnapshotResponseSchema = Type.Object({
  valueId: Type.String(),
  measureId: Type.String(),
  computeVersion: Type.String(),
  snapshotContentHash: Type.String(),
  computedAt: Type.String(),
  inputs: Type.Object({
    populationSourceTables: Type.Array(Type.String()),
    populationFilter: Type.String(),
    inputRowCounts: Type.Record(Type.String(), Type.Number()),
    parameters: m30Json(),
    thresholdConstants: m30Json(),
  }),
  intermediates: m30Nullable(m30Json()),
  output: Type.Object({
    numerator: Type.Number(),
    denominator: Type.Number(),
    rate: m30Nullable(Type.Number()),
  }),
});

/** `read-service.ts` → `RecomputeQueueEntryView`. The scope is a discriminated union, published as
 *  one so a client can narrow on `kind` instead of probing for optional fields. */
export const RecomputeQueueEntryViewSchema = Type.Object({
  jobId: Type.String(),
  scope: Type.Union([
    Type.Object({ kind: Type.Literal("all") }),
    Type.Object({ kind: Type.Literal("measure"), measureId: Type.String() }),
    Type.Object({
      kind: Type.Literal("domain"),
      domain: lit(RECOMPUTE_DOMAIN),
    }),
  ]),
  priority: lit(PRIORITY),
  enqueuedAt: Type.String(),
  state: lit(RECOMPUTE_JOB_STATE),
});
/** The queue read returns a BARE ARRAY — it is bounded by the queue, so it carries no cursor. */
export const RecomputeQueueResponseSchema = Type.Array(RecomputeQueueEntryViewSchema);

// ── CAHPS (R-10, R-12, R-15, R-17) ────────────────────────────────────────────────────────────

/** `read-service.ts` → `CahpsVendorBindingView`. */
export const CahpsVendorBindingViewSchema = Type.Object({
  bindingId: Type.String(),
  organizationId: Type.String(),
  vendorAdapterId: Type.String(),
  vendorName: Type.String(),
  effectiveFrom: Type.String(),
  effectiveTo: m30Nullable(Type.String()),
  isActive: Type.Boolean(),
});
/** NULLABLE on the wire: an org that has never bound a vendor is a 200 with `null`, not a 404 —
 *  "no vendor yet" is the normal pre-binding state, not a missing resource. */
export const CahpsVendorResponseSchema = m30Nullable(CahpsVendorBindingViewSchema);

/** `read-service.ts` → `CahpsDecedentView`. PHI (patient-linked). */
export const CahpsDecedentViewSchema = Type.Object({
  sampleId: Type.String(),
  organizationId: Type.String(),
  patientId: Type.String(),
  dateOfDeath: Type.String(),
  samplePeriodStart: Type.String(),
  samplePeriodEnd: Type.String(),
  eligible: Type.Boolean(),
  exclusionReason: m30Nullable(Type.String()),
});
export const CahpsDecedentListResponseSchema = m30PageOf(CahpsDecedentViewSchema);

/** `read-service.ts` → `CahpsExportJobView`. `downloadUrl` is a short-lived signed URL, present
 *  only once `status === "completed"`. */
export const CahpsExportJobResponseSchema = Type.Object({
  exportId: Type.String(),
  organizationId: Type.String(),
  vendorAdapterId: Type.String(),
  samplePeriodStart: Type.String(),
  samplePeriodEnd: Type.String(),
  status: lit(CAHPS_EXPORT_STATUS),
  decedentCount: Type.Integer(),
  downloadUrl: m30Nullable(Type.String()),
  createdAt: Type.String(),
  completedAt: m30Nullable(Type.String()),
  failureReason: m30Nullable(Type.String()),
});

/** `read-service.ts` → `CahpsResultSummaryView`. `topBoxPercent` is null when the cell was
 *  suppressed — `suppressedMinCell` is what distinguishes that from "not yet reported". */
export const CahpsResultSummaryViewSchema = Type.Object({
  resultId: Type.String(),
  organizationId: Type.String(),
  measureId: Type.String(),
  reportingPeriodStart: Type.String(),
  reportingPeriodEnd: Type.String(),
  topBoxPercent: m30Nullable(Type.Number()),
  suppressedMinCell: Type.Boolean(),
  ingestedAt: Type.String(),
});
export const CahpsResultListResponseSchema = m30PageOf(CahpsResultSummaryViewSchema);

// ── QAPI (R-20, R-23, R-29, R-33) ─────────────────────────────────────────────────────────────

/** `read-service.ts` → `QapiProgramView`. */
export const QapiProgramViewSchema = Type.Object({
  programId: Type.String(),
  organizationId: Type.String(),
  planYear: Type.Integer(),
  charterAdoptedAt: Type.String(),
  governanceComposition: Type.Array(M30GovernanceMemberSchema),
  status: lit(QAPI_PROGRAM_STATUS),
});
export const QapiProgramListResponseSchema = m30PageOf(QapiProgramViewSchema);

/** `read-service.ts` → `QapiIndicatorView`. `breached` is the SERVER's verdict against the
 *  threshold direction — a client re-deriving it from `currentRate` would get the `min`/`max`
 *  cases backwards half the time. */
export const QapiIndicatorViewSchema = Type.Object({
  indicatorId: Type.String(),
  organizationId: Type.String(),
  qapiProgramId: Type.String(),
  displayName: Type.String(),
  measureId: m30Nullable(Type.String()),
  thresholdDirection: lit(THRESHOLD_DIRECTION),
  thresholdValue: Type.Number(),
  currentRate: m30Nullable(Type.Number()),
  currentBand: m30Nullable(lit(MEASURE_BAND_COLOR)),
  breached: Type.Boolean(),
});
export const QapiIndicatorListResponseSchema = m30PageOf(QapiIndicatorViewSchema);

/** `read-service.ts` → `QapiPipView`. */
export const QapiPipViewSchema = Type.Object({
  pipId: Type.String(),
  organizationId: Type.String(),
  projectId: Type.String(),
  phase: lit(QAPI_PIP_PHASE),
  charterText: Type.String(),
  charteredByMembershipId: Type.String(),
  outcome: m30Nullable(Type.String()),
  closedAt: m30Nullable(Type.String()),
});
export const QapiPipListResponseSchema = m30PageOf(QapiPipViewSchema);

/** `read-service.ts` → `QapiGovernanceMinutesView`. */
export const QapiGovernanceMinutesViewSchema = Type.Object({
  minutesId: Type.String(),
  organizationId: Type.String(),
  qapiProgramId: Type.String(),
  meetingAt: Type.String(),
  recordedByMembershipId: Type.String(),
  summary: Type.String(),
  attendees: Type.Array(M30GovernanceMemberSchema),
});
export const QapiGovernanceListResponseSchema = m30PageOf(QapiGovernanceMinutesViewSchema);

// ── SRA (R-40, R-42) ──────────────────────────────────────────────────────────────────────────

/** `read-service.ts` → `SraCycleView`. */
export const SraCycleViewSchema = Type.Object({
  cycleId: Type.String(),
  organizationId: Type.String(),
  cycleYear: Type.Integer(),
  status: lit(SRA_CYCLE_STATUS),
  scopeTemplateVersion: Type.String(),
  ownerMembershipId: Type.String(),
  openedAt: Type.String(),
  closedAt: m30Nullable(Type.String()),
});
export const SraCycleListResponseSchema = m30PageOf(SraCycleViewSchema);

/** `read-service.ts` → `SraFindingView`. `riskScore`/`riskBand` are server-computed from
 *  likelihood × impact; both ride the wire so a UI never re-implements the banding. */
export const SraFindingViewSchema = Type.Object({
  findingId: Type.String(),
  cycleId: Type.String(),
  findingNumber: Type.Integer(),
  controlRef: Type.String(),
  likelihood: Type.Number(),
  impact: Type.Number(),
  riskScore: Type.Number(),
  riskBand: lit(SRA_RISK_BAND),
  disposition: lit(SRA_FINDING_DISPOSITION),
});

/** `read-service.ts` → `SraRemediationView`. */
export const SraRemediationViewSchema = Type.Object({
  remediationId: Type.String(),
  findingId: Type.String(),
  remediationNumber: Type.Integer(),
  plan: Type.String(),
  ownerMembershipId: Type.String(),
  dueAt: m30Nullable(Type.String()),
  status: lit(SRA_REMEDIATION_STATUS),
  completedAt: m30Nullable(Type.String()),
});

/** `read-service.ts` → `SraCycleDetailView` (cycle + progress + findings + remediations). */
export const SraCycleDetailResponseSchema = Type.Intersect([
  SraCycleViewSchema,
  Type.Object({
    progress: Type.Object({
      findingsCount: Type.Integer(),
      openFindingsCount: Type.Integer(),
      remediationsCount: Type.Integer(),
    }),
    findings: Type.Array(SraFindingViewSchema),
    remediations: Type.Array(SraRemediationViewSchema),
  }),
]);

// ── Incidents (R-52, R-61) ────────────────────────────────────────────────────────────────────

/** `read-service.ts` → `IncidentStateHistoryView`. `fromState` is null on the opening entry. */
export const IncidentStateHistoryViewSchema = Type.Object({
  fromState: m30Nullable(lit(INCIDENT_STATE)),
  toState: lit(INCIDENT_STATE),
  actorMembershipId: Type.String(),
  occurredAt: Type.String(),
});

/** `read-service.ts` → `IncidentInvestigationNoteView` (append-only). */
export const IncidentInvestigationNoteViewSchema = Type.Object({
  noteId: Type.String(),
  incidentId: Type.String(),
  authorMembershipId: Type.String(),
  body: Type.String(),
  createdAt: Type.String(),
});

/** `read-service.ts` → `IncidentCapPlanView` (corrective-action plan). */
export const IncidentCapPlanViewSchema = Type.Object({
  rootCauseSummary: Type.String(),
  actions: Type.Array(
    Type.Object({
      action: Type.String(),
      ownerMembershipId: Type.String(),
      dueAt: Type.String(),
      completedAt: m30Nullable(Type.String()),
    }),
  ),
  verificationCriteria: Type.String(),
});

/** `read-service.ts` → `IncidentDetailView`. PHI when patient-linked. `data` stays open — it is the
 *  kind-discriminated payload validated against the per-kind §4.2 schema on WRITE, and freezing one
 *  union here would fight that. */
export const IncidentDetailResponseSchema = Type.Intersect([
  IncidentSummaryViewSchema,
  Type.Object({
    data: m30Json(),
    capPlan: m30Nullable(IncidentCapPlanViewSchema),
    capVerifiedByMembershipId: m30Nullable(Type.String()),
    capVerifiedAt: m30Nullable(Type.String()),
    closedByMembershipId: m30Nullable(Type.String()),
    closedAt: m30Nullable(Type.String()),
    stateHistory: Type.Array(IncidentStateHistoryViewSchema),
    investigationNotes: Type.Array(IncidentInvestigationNoteViewSchema),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  }),
]);

// ── Mortality (R-70, R-71) ────────────────────────────────────────────────────────────────────

/** `read-service.ts` → `MortalityReviewSummaryView`. PHI. */
export const MortalityReviewSummaryViewSchema = Type.Object({
  reviewId: Type.String(),
  organizationId: Type.String(),
  patientId: Type.String(),
  dateOfDeath: Type.String(),
  assignedToMembershipId: m30Nullable(Type.String()),
  status: lit(MORTALITY_STATUS),
  targetCompletionAt: Type.String(),
  completedAt: m30Nullable(Type.String()),
});
export const MortalityListResponseSchema = m30PageOf(MortalityReviewSummaryViewSchema);

/** `read-service.ts` → `MortalityReviewDetailView`. Each dimension is independently nullable —
 *  a partially-reviewed death is the normal in-progress state. */
export const MortalityReviewDetailResponseSchema = Type.Intersect([
  MortalityReviewSummaryViewSchema,
  Type.Object({
    dimensions: Type.Object({
      clinical: m30Nullable(m30Json()),
      satisfaction: m30Nullable(m30Json()),
      compliance: m30Nullable(m30Json()),
    }),
    reviewerMembershipId: m30Nullable(Type.String()),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  }),
]);

// ── Infection (R-90, R-92) ────────────────────────────────────────────────────────────────────

/** `read-service.ts` → `InfectionEventView`. PHI. */
export const InfectionEventViewSchema = Type.Object({
  eventId: Type.String(),
  organizationId: Type.String(),
  patientId: Type.String(),
  pathogen: Type.String(),
  bodySite: Type.String(),
  observedAt: Type.String(),
  filedByMembershipId: Type.String(),
  outbreakCaseId: m30Nullable(Type.String()),
});
export const InfectionEventListResponseSchema = m30PageOf(InfectionEventViewSchema);

/** `read-service.ts` → `InfectionOutbreakView`. Aggregate-only — the case carries counts, never
 *  the patient ids of its member events. */
export const InfectionOutbreakViewSchema = Type.Object({
  caseId: Type.String(),
  organizationId: Type.String(),
  pathogen: Type.String(),
  bodySite: Type.String(),
  eventCount: Type.Integer(),
  firstEventAt: Type.String(),
  lastEventAt: Type.String(),
  status: lit(OUTBREAK_STATUS),
  resolvedAt: m30Nullable(Type.String()),
});
export const InfectionOutbreakListResponseSchema = m30PageOf(InfectionOutbreakViewSchema);

// ── Risk register (R-95) ──────────────────────────────────────────────────────────────────────

/** `read-service.ts` → `RiskRegisterEntryView`, projected from the `risk_register_view` MV.
 *  `status` stays open: it is the SOURCE module's status vocabulary, six different ones unioned. */
export const RiskRegisterEntryViewSchema = Type.Object({
  entryId: Type.String(),
  organizationId: Type.String(),
  source: lit(RISK_SOURCE),
  sourceRef: Type.String(),
  title: Type.String(),
  severity: lit(RISK_SEVERITY),
  status: Type.String(),
  openedAt: Type.String(),
  lastActivityAt: Type.String(),
});
export const RiskRegisterListResponseSchema = m30PageOf(RiskRegisterEntryViewSchema);

// ── CONFORMANCE: the DTOs above must match what `read-service.ts` actually returns ─────────────
//
// `read-service.ts` is the CONTRACT (what the handlers return); the DTOs above are its WIRE
// PROJECTION (what the OpenAPI document, and so every generated client, says they return). Nothing
// structural connects them — the DTOs are hand-authored — so a view field renamed, retyped or added
// would leave the published contract quietly wrong and every screen typed against a lie. That is the
// drift the M25 screens carried while they cast through `as unknown as Page<Row>`.
//
// These aliases are the proof, and they live HERE rather than in a test on purpose: `apps/backend`
// type-checks `src` only (`tsconfig.json` → `"include": ["src"]`), and vitest transpiles without
// type-checking, so the same assertions in `__tests__` would compile-check NOWHERE and rot silently.
// In this file, `bun run build` fails the moment a projection stops matching its view.
//
// Type-only import: zero runtime coupling, and no import cycle (read-service does not import this).
import type {
  CahpsDecedentView,
  CahpsExportJobView,
  CahpsResultSummaryView,
  CahpsVendorBindingView,
  CopCitationView,
  IncidentDetailView,
  IncidentSummaryView,
  InfectionEventView,
  InfectionOutbreakView,
  MeasureSummaryView,
  MeasureValueSeriesView,
  MeasureValueSnapshotView,
  MortalityReviewDetailView,
  MortalityReviewSummaryView,
  QapiGovernanceMinutesView,
  QapiIndicatorView,
  QapiPipView,
  QapiProgramView,
  QapiProjectView,
  RecomputeQueueEntryView,
  RiskRegisterEntryView,
  SraCycleDetailView,
  SraCycleView,
} from "./read-service";

/** Asserts `T` (what the schema publishes) is assignable to `V` (what the service returns). */
type Conforms<T extends V, V> = T;
/** The `{ items, nextCursor, hasMore }` envelope every M30 LIST read returns verbatim. */
type PageItem<S> = S extends { items: readonly (infer I)[] } ? I : never;
type Item<S> = PageItem<Static<S extends TSchema ? S : never>>;

// list reads — the page ITEM conforms to the view
type _Measures = Conforms<Item<typeof MeasureListResponseSchema>, MeasureSummaryView>;
type _Incidents = Conforms<Item<typeof IncidentListResponseSchema>, IncidentSummaryView>;
type _CopCitations = Conforms<Item<typeof CopCitationListResponseSchema>, CopCitationView>;
type _QapiProjects = Conforms<Item<typeof QapiProjectListResponseSchema>, QapiProjectView>;
type _CahpsDecedents = Conforms<Item<typeof CahpsDecedentListResponseSchema>, CahpsDecedentView>;
type _CahpsResults = Conforms<Item<typeof CahpsResultListResponseSchema>, CahpsResultSummaryView>;
type _QapiPrograms = Conforms<Item<typeof QapiProgramListResponseSchema>, QapiProgramView>;
type _QapiIndicators = Conforms<Item<typeof QapiIndicatorListResponseSchema>, QapiIndicatorView>;
type _QapiPips = Conforms<Item<typeof QapiPipListResponseSchema>, QapiPipView>;
type _QapiGovernance = Conforms<
  Item<typeof QapiGovernanceListResponseSchema>,
  QapiGovernanceMinutesView
>;
type _SraCycles = Conforms<Item<typeof SraCycleListResponseSchema>, SraCycleView>;
type _Mortality = Conforms<Item<typeof MortalityListResponseSchema>, MortalityReviewSummaryView>;
type _InfectionEvents = Conforms<Item<typeof InfectionEventListResponseSchema>, InfectionEventView>;
type _InfectionOutbreaks = Conforms<
  Item<typeof InfectionOutbreakListResponseSchema>,
  InfectionOutbreakView
>;
type _RiskRegister = Conforms<Item<typeof RiskRegisterListResponseSchema>, RiskRegisterEntryView>;

// detail + singleton reads
type _MeasureSeries = Conforms<
  Static<typeof MeasureValueSeriesResponseSchema>,
  MeasureValueSeriesView
>;
type _MeasureSnapshot = Conforms<
  Static<typeof MeasureValueSnapshotResponseSchema>,
  MeasureValueSnapshotView
>;
type _IncidentDetail = Conforms<Static<typeof IncidentDetailResponseSchema>, IncidentDetailView>;
type _SraCycleDetail = Conforms<Static<typeof SraCycleDetailResponseSchema>, SraCycleDetailView>;
type _MortalityDetail = Conforms<
  Static<typeof MortalityReviewDetailResponseSchema>,
  MortalityReviewDetailView
>;
type _CahpsExport = Conforms<Static<typeof CahpsExportJobResponseSchema>, CahpsExportJobView>;
// Three reads deliberately break the page envelope — the vendor read is NULLABLE (an org with no
// binding is a 200 `null`, not a 404) and the recompute queue is a BARE ARRAY (bounded by the queue,
// so it carries no cursor). A client that assumed `{ items }` everywhere would crash on both.
type _CahpsVendor = Conforms<
  Static<typeof CahpsVendorResponseSchema>,
  CahpsVendorBindingView | null
>;
type _RecomputeQueue = Conforms<
  Static<typeof RecomputeQueueResponseSchema>[number],
  RecomputeQueueEntryView
>;
