// apps/backend/src/modules/06-admission/routes/admission-typebox.ts — M6-T06 TypeBox route schemas
// (§4.2). Named `admission-typebox` (NOT `*schema*`) so the table-ownership import heuristic never
// mistakes a TypeBox import for a Drizzle one. Validation runs through TypeBox `Value` → M1's
// VALIDATION_FAILED envelope. Schemas mirror §4.2 1:1 (abbreviated where the spec is). Optimistic
// locking: state-change PATCH/POST routes carry `ifVersion`.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import type {
  AdmissionDetail as ServiceAdmissionDetail,
  Page as ServicePage,
  PatientElectionCertificationView as ServicePatientElectionCert,
  SummaryRow as ServiceSummaryRow,
} from "./service";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set(
    "date",
    (v) => typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)),
  );
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}

// Slice ids are non-uuid synthetic (`adm_1`); routes accept a loose id param. Cross-module ids
// (patientId, physicianId) are validated as uuids per §4.2.
export const IdParamsSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });
// Loose string (matches IdParamsSchema, not uuid-format) so the param convention is uniform across M6
// routes; the service resolves a non-existent patient to a truthful empty aggregate, never an error.
export const PatientIdParamsSchema = Type.Object({
  patientId: Type.String({ minLength: 1, maxLength: 64 }),
});

const Uuid = () => Type.String({ format: "uuid" });
const Reason = (min = 10, max = 4000) => Type.String({ minLength: min, maxLength: max });
const Version = () => Type.Integer({ minimum: 0 });
const Icd10 = () => Type.String({ pattern: "^[A-Z][0-9A-Z.]{1,7}$" });
const Npi = () => Type.String({ pattern: "^[0-9]{10}$" });

// ── Referral (routes 1–7) ──────────────────────────────────────────────────────────────────────
const REFERRAL_SOURCES = [
  "phone",
  "fax",
  "portal",
  "walk_in",
  "self_referral",
  "physician_office",
  "hospital_discharge_planner",
] as const;

export const ReferralCreateSchema = Type.Object({
  source: Type.Union(REFERRAL_SOURCES.map((s) => Type.Literal(s))),
  receivedAt: Type.String({ format: "date-time" }),
  receivingUserId: Uuid(),
  patientNameAtReceipt: Type.String({ minLength: 1, maxLength: 200 }),
  patientDobAtReceipt: Type.Optional(Type.String({ format: "date" })),
  referringDxText: Type.Optional(Type.String({ maxLength: 2000 })),
  referrerName: Type.Optional(Type.String({ maxLength: 200 })),
  referrerOrganization: Type.Optional(Type.String({ maxLength: 200 })),
  referrerPhone: Type.Optional(Type.String({ maxLength: 32 })),
  externalReferralId: Type.Optional(Type.String({ maxLength: 128 })),
});

export const ReferralListQuerySchema = Type.Object({
  status: Type.Optional(Type.String({ maxLength: 32 })),
  source: Type.Optional(Type.String({ maxLength: 32 })),
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const ReferralTriageSchema = Type.Object({
  outcome: Type.Union([Type.Literal("eligible"), Type.Literal("ineligible")]),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
  ifVersion: Version(),
});

export const ReferralAcceptSchema = Type.Object({
  patientId: Type.Optional(Uuid()),
  primaryDiagnosisIcd10: Icd10(),
  attendingPhysicianId: Type.Optional(Uuid()),
  ifVersion: Version(),
});

export const ReferralDeclineSchema = Type.Object({
  reason: Reason(10, 1000),
  ifVersion: Version(),
});

export const ReferralUpdateSchema = Type.Object({
  referringDxText: Type.Optional(Type.String({ maxLength: 2000 })),
  referrerName: Type.Optional(Type.String({ maxLength: 200 })),
  referrerOrganization: Type.Optional(Type.String({ maxLength: 200 })),
  referrerPhone: Type.Optional(Type.String({ maxLength: 32 })),
  ifVersion: Version(),
});

// ── Admission (routes 8–14) ────────────────────────────────────────────────────────────────────
const INTAKE_METHODS = ["in_person", "phone", "referral_auto", "transfer_in"] as const;

export const AdmissionCreateSchema = Type.Object({
  patientId: Uuid(),
  referralId: Type.Optional(Uuid()),
  intakeMethod: Type.Union(INTAKE_METHODS.map((m) => Type.Literal(m))),
  attendingPhysicianId: Type.Optional(Uuid()),
  hospiceMedicalDirectorId: Uuid(),
});

export const AdmissionListQuerySchema = Type.Object({
  state: Type.Optional(Type.String({ maxLength: 32 })),
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const AdmissionUpdateSchema = Type.Object({
  intakeMethod: Type.Optional(Type.Union(INTAKE_METHODS.map((m) => Type.Literal(m)))),
  attendingPhysicianId: Type.Optional(Uuid()),
  ifVersion: Version(),
});

export const AdmissionActivateSchema = Type.Object({ ifVersion: Version() });
export const AdmissionHoldSchema = Type.Object({ reason: Reason(10, 500), ifVersion: Version() });
export const AdmissionResumeSchema = Type.Object({ ifVersion: Version() });

// ── Election statement & period (routes 15–21) ───────────────────────────────────────────────────
export const ElectionStatementDraftSchema = Type.Object({
  electionPeriodId: Uuid(),
  effectiveDate: Type.String({ format: "date" }),
  primaryDiagnosisIcd10: Icd10(),
  electedProviderEntityId: Uuid(),
  electedAttendingPhysicianId: Type.Optional(Uuid()),
  waiverAcknowledged: Type.Boolean(),
  stateAddendum: Type.Optional(Type.String({ maxLength: 5000 })),
});

export const ElectionSignSchema = Type.Object({
  signingPatientName: Type.String({ minLength: 1, maxLength: 200 }),
  signingRole: Type.Union([Type.Literal("patient"), Type.Literal("legal_representative")]),
  ifVersion: Version(),
});

export const ElectionVoidSchema = Type.Object({ reason: Reason(10, 1000), ifVersion: Version() });

export const ElectionPeriodCreateSchema = Type.Object({
  effectiveStart: Type.String({ format: "date" }),
  kind: Type.Union([Type.Literal("ninety_day"), Type.Literal("sixty_day")]),
});

export const ElectionPeriodPatchSchema = Type.Object({
  effectiveStart: Type.Optional(Type.String({ format: "date" })),
  ifVersion: Version(),
});

// ── CTI (routes 22–27) ───────────────────────────────────────────────────────────────────────────
export const CtiDraftSchema = Type.Object({
  hospiceMedicalDirectorId: Uuid(),
  attendingPhysicianId: Type.Optional(Uuid()),
  prognosisStatement: Type.String({ minLength: 1, maxLength: 200 }),
  narrative: Type.String({ minLength: 1, maxLength: 4000 }),
  clinicalFindings: Type.Object({}, { additionalProperties: true }),
  isRecert: Type.Boolean(),
});

export const CtiSignSchema = Type.Object({
  signingPhysicianName: Type.String({ minLength: 1, maxLength: 200 }),
  signingPhysicianNpi: Npi(),
  ifVersion: Version(),
});

export const CtiVoidSchema = Type.Object({ reason: Reason(10, 500), ifVersion: Version() });

export const CtiMarkLateSchema = Type.Object({
  oralCertVerbalAt: Type.String({ format: "date-time" }),
  oralCertVerbalBy: Type.String({ minLength: 1, maxLength: 200 }),
  reason: Reason(10, 500),
  ifVersion: Version(),
});

// ── F2F (routes 28–32) ─────────────────────────────────────────────────────────────────────────
export const F2fScheduleSchema = Type.Object({
  electionPeriodId: Uuid(),
  scheduledDate: Type.String({ format: "date" }),
  windowStart: Type.String({ format: "date" }),
  windowEnd: Type.String({ format: "date" }),
  clinicianRole: Type.Union([Type.Literal("hospice_np"), Type.Literal("hospice_md")]),
  scheduledClinicianId: Uuid(),
});

export const F2fCompleteSchema = Type.Object({
  encounterDate: Type.String({ format: "date" }),
  ifVersion: Version(),
});

export const F2fAttestSchema = Type.Object({
  attestationNarrative: Type.String({ minLength: 1, maxLength: 4000 }),
  ifVersion: Version(),
});

export const F2fOverrideWindowSchema = Type.Object({
  reason: Reason(20, 1000),
  ifVersion: Version(),
});

// ── Level of care (routes 33–35) ─────────────────────────────────────────────────────────────────
export const LocChangeSchema = Type.Object({
  newLevel: Type.Union([
    Type.Literal("rhc"),
    Type.Literal("crc"),
    Type.Literal("gip"),
    Type.Literal("iri"),
  ]),
  effectiveStart: Type.String({ format: "date" }),
  reason: Reason(10, 1000),
});

export const LocPatchSchema = Type.Object({ reason: Reason(10, 1000), ifVersion: Version() });

// ── Revocation / transfer / discharge (routes 36–40) ─────────────────────────────────────────────
export const RevocationCreateSchema = Type.Object({
  revocationDate: Type.String({ format: "date" }),
  narrative: Reason(10, 4000),
  signingPatientName: Type.String({ minLength: 1, maxLength: 200 }),
  signingRole: Type.Union([Type.Literal("patient"), Type.Literal("legal_representative")]),
});

export const TransferOutSchema = Type.Object({
  direction: Type.Literal("out"),
  effectiveDate: Type.String({ format: "date" }),
  otherHospiceName: Type.String({ minLength: 1, maxLength: 200 }),
  otherHospiceCcn: Type.Optional(Type.String({ pattern: "^[0-9A-Z]{6}$" })),
  narrative: Reason(10, 4000),
});

export const TransferInSchema = Type.Object({
  direction: Type.Literal("in"),
  effectiveDate: Type.String({ format: "date" }),
  otherHospiceName: Type.String({ minLength: 1, maxLength: 200 }),
  otherHospiceCcn: Type.Optional(Type.String({ pattern: "^[0-9A-Z]{6}$" })),
  priorBenefitPeriodSequence: Type.Integer({ minimum: 1 }),
  priorElectionStartDate: Type.String({ format: "date" }),
  narrative: Reason(10, 4000),
});

// The canonical reason list + the §6.3 permission/narrative policy live in the pure `discharge/`
// submodule (M6-T09); re-exported here so existing importers keep resolving `DischargeReason` from the
// TypeBox module and the schema union stays in lock-step with the policy table.
export { DISCHARGE_REASONS, type DischargeReason } from "../discharge";
import { DISCHARGE_REASONS } from "../discharge";

export const DischargeCreateSchema = Type.Object({
  reason: Type.Union(DISCHARGE_REASONS.map((r) => Type.Literal(r))),
  dischargeDate: Type.String({ format: "date" }),
  narrative: Reason(10, 4000),
  forCauseReason: Type.Optional(Type.String({ minLength: 20, maxLength: 2000 })),
});

export const DischargeCosignSchema = Type.Object({
  cosignerName: Type.String({ minLength: 1, maxLength: 200 }),
  cosignerNpi: Npi(),
  ifVersion: Version(),
});

// ── NOR & compliance windows (routes 41–46) ──────────────────────────────────────────────────────
const NOR_METHODS = ["wet_ink_scanned", "electronic_witnessed", "verbal_with_witness"] as const;

export const NorAcknowledgeSchema = Type.Object({
  formVersionId: Uuid(),
  deliveryMethod: Type.Union(NOR_METHODS.map((m) => Type.Literal(m))),
  acknowledgedAt: Type.String({ format: "date-time" }),
  acknowledgedByName: Type.String({ minLength: 1, maxLength: 200 }),
  acknowledgedByRole: Type.Union([Type.Literal("patient"), Type.Literal("legal_representative")]),
});

export const ComplianceListQuerySchema = Type.Object({
  state: Type.Optional(Type.String({ maxLength: 32 })),
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const ComplianceCloseSchema = Type.Object({ ifVersion: Version() });
export const ComplianceOverrideSchema = Type.Object({
  reason: Reason(20, 1000),
  ifVersion: Version(),
});

// ── §4.2 RESPONSE DTOs (F0 enrichment) ─────────────────────────────────────────────────────────────
// The read routes returned typed view shapes (`SummaryRow` / `AdmissionDetail` / `Page<SummaryRow>`) but
// published NO response contract, so the generated client typed every GET body as `never`. These DTOs
// mirror the service's read views 1:1 and are pinned to them by the compile-time `Conforms` aliases below,
// so a view field added or renamed breaks `bun run build` rather than silently drifting from the client.
export const SummaryRowResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
});

const ActivationGapSchema = Type.Union([
  Type.Literal("election_signed"),
  Type.Literal("nor_acknowledged"),
  Type.Literal("cti_signed"),
  Type.Literal("attending_signed"),
]);

/** Route 10 — the admission aggregate: summary + the R-AC-01 activation gate (§7.2 / §5.2.5). */
export const AdmissionDetailResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
  activationGate: Type.Object({
    ready: Type.Boolean(),
    missing: Type.Array(ActivationGapSchema),
  }),
});

/** The cursor-paginated page the list routes return (`{ items, nextCursor }`). */
export const SummaryPageResponseSchema = Type.Object({
  items: Type.Array(SummaryRowResponseSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

/** The bounded `{ items }` envelope the per-admission sub-list reads return (no cursor). */
export const SummaryItemsResponseSchema = Type.Object({
  items: Type.Array(SummaryRowResponseSchema),
});

// Patient-scoped Election & Certification aggregate (patient-chart tab). `admission` is null when the
// patient has no admission yet; the ladders are then empty. Dates are ISO strings (timestamps) or date
// strings. NOTE: `periods` is published as a loose record array on purpose — each period item nests three
// sub-objects (election statement / CTI / F2F), and publishing that full depth makes openapi-fetch's
// generated client type instantiate past TypeScript's depth limit (TS2589) once it is one operation among
// 1000+. The rich per-period shape is the `PatientElectionCertificationView.periods` service type, which
// the screen casts to; the live-RLS suite is the correctness proof for the assembled shape.
const NullableStr = Type.Union([Type.String(), Type.Null()]);
export const PatientElectionCertificationResponseSchema = Type.Object({
  admission: Type.Union([
    Type.Object({
      id: Type.String(),
      state: Type.String(),
      admissionAt: NullableStr,
      activatedAt: NullableStr,
      dischargedAt: NullableStr,
      version: Type.Integer(),
    }),
    Type.Null(),
  ]),
  periods: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  complianceWindows: Type.Array(
    Type.Object({
      id: Type.String(),
      windowKind: Type.String(),
      severity: Type.String(),
      status: Type.String(),
      mustCompleteBy: Type.String(),
      closedAt: NullableStr,
    }),
  ),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _SummaryRow = Conforms<Static<typeof SummaryRowResponseSchema>, ServiceSummaryRow>;
type _AdmissionDetail = Conforms<Static<typeof AdmissionDetailResponseSchema>, ServiceAdmissionDetail>;
type _SummaryPage = Conforms<Static<typeof SummaryPageResponseSchema>, ServicePage<ServiceSummaryRow>>;
type _SummaryItems = Conforms<
  Static<typeof SummaryItemsResponseSchema>,
  { readonly items: readonly ServiceSummaryRow[] }
>;
// The published election/cert schema keeps `admission` + `complianceWindows` pinned to the service view;
// `periods` is intentionally loose (see the schema note), so we pin only the flat, non-nested slices.
type _PatientElectionCertFlat = Conforms<
  Pick<Static<typeof PatientElectionCertificationResponseSchema>, "admission" | "complianceWindows">,
  Pick<ServicePatientElectionCert, "admission" | "complianceWindows">
>;

/** Parse `raw` through `schema` → typed value, or throw M1's VALIDATION_FAILED envelope. */
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
