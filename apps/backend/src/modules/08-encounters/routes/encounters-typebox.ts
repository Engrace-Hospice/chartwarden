// apps/backend/src/modules/08-encounters/routes/encounters-typebox.ts — M8-T09 TypeBox route schemas
// (§4.2). Named `encounters-typebox` (NOT `*schema*`) so the table-ownership import heuristic never
// mistakes a TypeBox import for a Drizzle one. Validation runs through TypeBox `Value` → M1's
// VALIDATION_FAILED envelope. Schemas mirror §4.2 (abbreviated where the spec spells out only the
// consequential routes). Optimistic concurrency rides the `If-Match` header (NOT the body); the sign
// routes carry the client's step-up timestamp (verified server-side ≤ 5 min stale, §2.7 D13).
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import type {
  CreatedEncounter as ServiceCreatedEncounter,
  EncounterView as ServiceEncounterView,
  MileageResult as ServiceMileageResult,
  EncounterRouteService as ServiceRouteApi,
  VitalsResult as ServiceVitalsResult,
} from "./service";

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

// §2.2 vocab mirrors (string-literal unions; the canonical types live in @wardenx/types).
const ENCOUNTER_TYPE = [
  "routine_visit",
  "admission_visit",
  "recert_visit",
  "face_to_face",
  "telephonic",
  "lpn_visit",
  "chha_visit",
  "msw_assessment",
  "msw_followup",
  "chaplain_assessment",
  "chaplain_visit",
  "volunteer_visit",
  "bereavement_contact",
  "idg_followup",
] as const;
const ENCOUNTER_DISCIPLINE = [
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
  "volunteer",
  "md",
  "np",
] as const;

const Text = (min = 1, max = 4000) => Type.String({ minLength: min, maxLength: max });

// ── Path params (slice ids are uuid-shaped; cross-module ids are validated uuids per §4.2) ───────────
export const EncounterParamsSchema = Type.Object({
  encounterId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const VitalParamsSchema = Type.Object({
  encounterId: Type.String({ minLength: 1, maxLength: 64 }),
  vitalId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const CarePlanLinkParamsSchema = Type.Object({
  encounterId: Type.String({ minLength: 1, maxLength: 64 }),
  linkId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const ModificationParamsSchema = Type.Object({
  encounterId: Type.String({ minLength: 1, maxLength: 64 }),
  modId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const AddendumParamsSchema = Type.Object({
  encounterId: Type.String({ minLength: 1, maxLength: 64 }),
  addendumId: Type.String({ minLength: 1, maxLength: 64 }),
});

// ── Bodies ──────────────────────────────────────────────────────────────────────────────────────────
export const CreateEncounterSchema = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  admissionId: Type.String({ format: "uuid" }),
  visitId: Type.Optional(Type.String({ format: "uuid" })),
  encounterType: lit(ENCOUNTER_TYPE),
  discipline: lit(ENCOUNTER_DISCIPLINE),
  serviceDate: Type.String({ format: "date" }),
  faceToFaceEncounterId: Type.Optional(Type.String({ format: "uuid" })),
  bereavementPlanId: Type.Optional(Type.String({ format: "uuid" })),
});

// §2.6 — the HearthNote selection tree a clinician builds against the template for their
// (encounterType × discipline) pair. This used to be `{ selections: Record<string, unknown>, freeText?:
// Record<string, string> }`: a shape that validated nothing, imported by `scripts/openapi/enrichments.ts`
// and by NO route file, and parsed by neither PATCH — it existed to be published, not to be read (#114).
// It is now the real shape, because the note is a legal clinical record and `Type.Unknown()` in a jsonb
// column is how a record becomes unreadable later. Widening the validation is free here: the routes
// discarded every body ever sent, so there is no caller whose payload this newly rejects.
//
// The client sends SECTIONS only. `templateKey`, `vocabVersion`, `encounterType` and `discipline` are
// server-derived from the encounter row — a client that could name its own template key could assemble a
// note against a template the encounter's discipline is not allowed to use.
const SelectionEntrySchema = Type.Object({
  /** A `@wardenx/narrative-vocab` entry code; assembly rejects one that is not in the shipped corpus. */
  code: Type.String({ minLength: 1, maxLength: 64 }),
  /** Values for the phrase template's `${slot}`s (numeric-direct vitals, grades, scores). */
  params: Type.Optional(
    Type.Record(
      Type.String({ maxLength: 64 }),
      Type.Union([Type.String({ maxLength: 200 }), Type.Number()]),
    ),
  ),
});
const SelectionSectionSchema = Type.Object({
  /** Must name a section of the resolved template (§2.6); an unknown id is a 422. */
  sectionId: Type.String({ minLength: 1, maxLength: 64 }),
  entries: Type.Array(SelectionEntrySchema, { maxItems: 200 }),
  /** Verbatim clinician prose. Sealed per-tenant DEK at rest — never stored in the clear (§3.6). */
  freeText: Type.Optional(Type.String({ maxLength: 20_000 })),
});
export const UpdateSelectionsSchema = Type.Object({
  sections: Type.Array(SelectionSectionSchema, { maxItems: 100 }),
});

// §2.2 — numeric-direct vitals (the `vitals` row shape; numerics-as-text preserve their unit). "Clinically
// not indicated" is a first-class value: a non-empty field list carries a documented reason, not a NULL.
const VITAL_UNIT = [
  "mmHg",
  "bpm",
  "breaths_per_min",
  "c",
  "f",
  "percent_o2",
  "kg",
  "lb",
  "cm",
  "in",
  "mg_dl",
  "mmol_l",
] as const;
const PAIN_SCALE = ["nrs_0_10", "flacc", "painad", "verbal_descriptor"] as const;
const Int = Type.Optional(Type.Integer());
export const CaptureVitalsSchema = Type.Object({
  bpSystolic: Int,
  bpDiastolic: Int,
  heartRate: Int,
  respiratoryRate: Int,
  temperature: Type.Optional(Type.String({ maxLength: 16 })),
  temperatureUnit: Type.Optional(lit(VITAL_UNIT)),
  spo2: Int,
  painScore: Int,
  painScale: Type.Optional(lit(PAIN_SCALE)),
  weight: Type.Optional(Type.String({ maxLength: 16 })),
  weightUnit: Type.Optional(lit(VITAL_UNIT)),
  height: Type.Optional(Type.String({ maxLength: 16 })),
  heightUnit: Type.Optional(lit(VITAL_UNIT)),
  bloodGlucose: Int,
  bloodGlucoseUnit: Type.Optional(lit(VITAL_UNIT)),
  clinicallyNotIndicatedFields: Type.Optional(Type.Array(Type.String({ maxLength: 64 }))),
  clinicallyNotIndicatedReason: Type.Optional(Type.String({ maxLength: 4000 })),
});

// §2.2 D10 — per-encounter mileage; the source picks how `miles_driven` is resolved.
const MILES_SOURCE = ["odometer", "route_calc", "manual_override"] as const;
export const CaptureMileageSchema = Type.Object({
  odometerStart: Int,
  odometerEnd: Int,
  milesDriven: Type.Optional(Type.String({ maxLength: 32 })),
  source: lit(MILES_SOURCE),
  manualOverrideReason: Type.Optional(Type.String({ maxLength: 4000 })),
  routeProposedMiles: Type.Optional(Type.String({ maxLength: 32 })),
});

export const CarePlanLinkSchema = Type.Object({
  problemId: Type.Optional(Type.String({ format: "uuid" })),
  goalId: Type.Optional(Type.String({ format: "uuid" })),
  interventionId: Type.Optional(Type.String({ format: "uuid" })),
});

export const EvvReconcileSchema = Type.Object({
  evvMissingReason: Type.String({ minLength: 20, maxLength: 4000 }),
});

export const FinalizeEncounterSchema = Type.Object({});

export const HearthnoteEnhanceSchema = Type.Object({
  style: Type.Object({
    tone: Type.Union([Type.Literal("formal"), Type.Literal("conversational")]),
    brevity: Type.Union([Type.Literal("concise"), Type.Literal("detailed")]),
  }),
});

export const ModificationDecisionSchema = Type.Object({
  decision: Type.Union([Type.Literal("accept"), Type.Literal("edit"), Type.Literal("reject")]),
  editedText: Type.Optional(Type.String({ maxLength: 4000 })),
});

// PARAM-004/CoP-418.104(c) follow-up: `stepUpAuthAt` used to be a client-supplied timestamp the route
// trusted at face value (see git history) — the actual freshness/method/session provenance now comes
// server-side from M2's SessionContextResolver seam (packages/auth's requireStepUp preHandler + the
// route's own re-resolution), never from anything the client asserts. `attestationConfirmed` stays: a
// real "I attest" client confirmation, independent of how the signature is cryptographically proven.
export const SignEncounterSchema = Type.Object({
  attestationConfirmed: Type.Literal(true),
});

export const LateEntryOverrideSchema = Type.Object({
  reason: Text(40),
  stepUpAuthAt: Type.String({ format: "date-time" }),
});

export const AdministrativeOverrideSchema = Type.Object({
  reason: Text(100),
  stepUpAuthAt: Type.String({ format: "date-time" }),
});

export const VoidEncounterSchema = Type.Object({
  reason: Text(40),
});

export const SupervisorReleaseSchema = Type.Object({
  reason: Text(40),
  stepUpAuthAt: Type.String({ format: "date-time" }),
});

export const CreateAddendumSchema = Type.Object({
  reason: Type.String({ minLength: 20, maxLength: 4000 }),
});

// ── Queries ───────────────────────────────────────────────────────────────────────────────────────
export const EncounterListQuerySchema = Type.Object({
  patientId: Type.Optional(Type.String({ maxLength: 64 })),
  authorId: Type.Optional(Type.String({ maxLength: 64 })),
  status: Type.Optional(Type.String({ maxLength: 32 })),
  lateEntryTier: Type.Optional(Type.String({ maxLength: 32 })),
  from: Type.Optional(Type.String({ maxLength: 32 })),
  to: Type.Optional(Type.String({ maxLength: 32 })),
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const BillableQuerySchema = Type.Object({
  encounterIds: Type.Array(Type.String({ format: "uuid" }), { maxItems: 500 }),
});

export const SignedSinceQuerySchema = Type.Object({
  since: Type.String({ format: "date-time" }),
  patientId: Type.Optional(Type.String({ maxLength: 64 })),
});

// ── §4.2 RESPONSE DTOs (F0 enrichment) ─────────────────────────────────────────────────────────────
// The read routes returned typed view shapes (EncounterView, VitalsResult, the cosignature/lifecycle
// result envelopes) but published NO response contract, so the generated client typed every GET/mutation
// body as `never`. These DTOs mirror the service's read views 1:1 and are pinned to them by the
// compile-time `Conforms` aliases below (via `Awaited<ReturnType<…>>` off the real service surface), so a
// view field added or renamed breaks `bun run build` rather than silently drifting from the client.
const ENCOUNTER_STATUS = [
  "draft",
  "finalized",
  "signed",
  "cosign_pending",
  "cosigned",
  "voided",
] as const;
const COSIGNATURE_STATUS = [
  "pending",
  "routed",
  "acknowledged",
  "escalated",
  "hard_cap_reached",
  "supervisor_released",
  "signed",
] as const;

/** Route 1 — the created draft summary (`{ id, status, templateKey, templateVersion, version }`). */
export const CreatedEncounterResponseSchema = Type.Object({
  id: Type.String(),
  status: Type.Literal("draft"),
  templateKey: Type.String(),
  templateVersion: Type.String(),
  version: Type.Integer(),
});

/** Route 2 — the encounter aggregate view (`getEncounter` / the list-row shape). */
export const EncounterViewResponseSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  visitId: Type.Union([Type.String(), Type.Null()]),
  encounterType: lit(ENCOUNTER_TYPE),
  discipline: lit(ENCOUNTER_DISCIPLINE),
  serviceDate: Type.String(),
  status: lit(ENCOUNTER_STATUS),
  lateEntryTier: Type.String(),
  version: Type.Integer(),
  authoredByUserId: Type.String(),
  isF2f: Type.Boolean(),
  signedAt: Type.Union([Type.String(), Type.Null()]),
  cosignedAt: Type.Union([Type.String(), Type.Null()]),
});

/** The `{ encounters }` envelope the list / queue / my-drafts / signed-since reads return. */
export const EncounterListResponseSchema = Type.Object({
  encounters: Type.Array(EncounterViewResponseSchema),
});

/** Routes 4/5 — a vitals capture/edit result (§4.4 decorators). */
export const VitalsResultResponseSchema = Type.Object({
  vitalsId: Type.String(),
  fieldsCaptured: Type.Array(Type.String()),
  abnormalFlags: Type.Array(Type.String()),
  bmi: Type.Union([Type.String(), Type.Null()]),
});

/**
 * Route 5b — one stored vitals set read back (#92). Nullable rather than optional on every field:
 * the row exists and the measurement is genuinely absent, which is a different clinical statement
 * from "this key was not sent" — a `null` spo2 on a signed encounter says nobody recorded it.
 */
const NullableInt = Type.Union([Type.Integer(), Type.Null()]);
const NullableStr = Type.Union([Type.String(), Type.Null()]);
const NullableUnit = Type.Union([lit(VITAL_UNIT), Type.Null()]);
export const VitalsViewResponseSchema = Type.Object({
  id: Type.String(),
  encounterId: Type.String(),
  capturedAt: Type.String(),
  bpSystolic: NullableInt,
  bpDiastolic: NullableInt,
  heartRate: NullableInt,
  respiratoryRate: NullableInt,
  temperature: NullableStr,
  temperatureUnit: NullableUnit,
  spo2: NullableInt,
  painScore: NullableInt,
  painScale: Type.Union([lit(PAIN_SCALE), Type.Null()]),
  weight: NullableStr,
  weightUnit: NullableUnit,
  height: NullableStr,
  heightUnit: NullableUnit,
  bmi: NullableStr,
  bloodGlucose: NullableInt,
  bloodGlucoseUnit: NullableUnit,
  clinicallyNotIndicatedFields: Type.Union([Type.Array(Type.String()), Type.Null()]),
  clinicallyNotIndicatedReason: NullableStr,
  abnormalFlags: Type.Array(Type.String()),
});

/** Route 5b — the `{ encounterId, vitals }` envelope, newest capture first. */
export const VitalsListResponseSchema = Type.Object({
  encounterId: Type.String(),
  vitals: Type.Array(VitalsViewResponseSchema),
});

/** Routes 6/7 — the authoritative mileage figure (D10). */
export const MileageResultResponseSchema = Type.Object({
  mileageId: Type.String(),
  milesDriven: Type.String(),
  source: Type.String(),
});

/** Route 3 — selections update (version bump + Layer-1 preview). */
export const SelectionsUpdateResponseSchema = Type.Object({
  version: Type.Integer(),
  layer1Preview: Type.String(),
});

/** Routes 3b / 23b — read the stored selection tree back, with its assembled Layer-1 narrative (#114). */
export const SelectionsViewResponseSchema = Type.Object({
  templateKey: Type.String(),
  vocabVersion: Type.String(),
  sections: Type.Array(
    Type.Object({
      sectionId: Type.String(),
      entries: Type.Array(
        Type.Object({
          code: Type.String(),
          params: Type.Optional(
            Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])),
          ),
        }),
      ),
      /** Absent when the section carries no prose, or when no cipher is bound to open it. */
      freeText: Type.Optional(Type.String()),
    }),
  ),
  /** The Layer-1 assembly of the stored tree — the note as it currently reads. */
  layer1Preview: Type.String(),
  version: Type.Integer(),
});

/** Route 8 — care-plan link created. */
export const CarePlanLinkResponseSchema = Type.Object({ linkId: Type.String() });

/** Route 10 — EVV-missing documented (D9 bracket state). */
export const EvvReconcileResponseSchema = Type.Object({ evvBracketState: Type.String() });

/** Route 11 — finalize (Layer-3 gate preview passed). */
export const FinalizeResponseSchema = Type.Object({
  status: Type.Literal("finalized"),
  version: Type.Integer(),
});

/** Routes 12/13 — HearthNote enhancement / per-passage modification decision. */
export const ModificationResponseSchema = Type.Object({ modificationId: Type.String() });

/** Route 14 — sign result (signed or routed to cosignature). */
export const SignResponseSchema = Type.Object({
  status: Type.Union([Type.Literal("signed"), Type.Literal("cosign_pending")]),
  signedAt: Type.String(),
  cosignatureRequestId: Type.Union([Type.String(), Type.Null()]),
});

/** Routes 15/16 — late-entry / administrative override (returns the current encounter status). */
export const EncounterStatusResponseSchema = Type.Object({ status: lit(ENCOUNTER_STATUS) });

/** Route 17 — void a draft. */
export const VoidResponseSchema = Type.Object({ status: Type.Literal("voided") });

/** Route 18 — read cosignature-request state (null before any routing). */
export const CosignatureReadResponseSchema = Type.Object({
  status: Type.Union([lit(COSIGNATURE_STATUS), Type.Null()]),
});

/** Routes 19/21 — cosignature acknowledge / supervisor-release (returns the cosignature state). */
export const CosignatureStatusResponseSchema = Type.Object({ status: lit(COSIGNATURE_STATUS) });

/** Route 20 — cosigner signs (encounter transitions to cosigned). */
export const CosignSignResponseSchema = Type.Object({
  status: lit(ENCOUNTER_STATUS),
  cosignedAt: Type.String(),
});

/** Route 22 — addendum draft created. */
export const CreateAddendumResponseSchema = Type.Object({
  id: Type.String(),
  status: Type.Literal("draft"),
});

/** Route 23 — addendum selections update (version bump + Layer-1 preview). */
export const AddendumSelectionsResponseSchema = Type.Object({
  version: Type.Integer(),
  layer1Preview: Type.String(),
});

/** Route 24 — addendum finalize. */
export const AddendumFinalizeResponseSchema = Type.Object({ status: Type.Literal("finalized") });

/** Route 25 — addendum sign. */
export const AddendumSignResponseSchema = Type.Object({
  status: Type.Literal("signed"),
  signedAt: Type.String(),
});

/** Route 29 — BillableEncounterReader seam projection (M23/M24). */
export const BillableResponseSchema = Type.Object({
  billability: Type.Array(Type.Object({ encounterId: Type.String(), billable: Type.Boolean() })),
});

/** Route 31 — M22 PDF-render payload. */
export const RenderPayloadResponseSchema = Type.Object({
  encounterId: Type.String(),
  final: Type.String(),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Ret<K extends keyof ServiceRouteApi> = Awaited<ReturnType<ServiceRouteApi[K]>>;
type Conforms<T extends V, V> = T;
type _Created = Conforms<Static<typeof CreatedEncounterResponseSchema>, ServiceCreatedEncounter>;
type _View = Conforms<Static<typeof EncounterViewResponseSchema>, ServiceEncounterView>;
type _List = Conforms<Static<typeof EncounterListResponseSchema>, Ret<"listEncounters">>;
type _Vitals = Conforms<Static<typeof VitalsResultResponseSchema>, ServiceVitalsResult>;
type _VitalsList = Conforms<Static<typeof VitalsListResponseSchema>, Ret<"listVitals">>;
type _Mileage = Conforms<Static<typeof MileageResultResponseSchema>, ServiceMileageResult>;
type _Selections = Conforms<Static<typeof SelectionsUpdateResponseSchema>, Ret<"updateSelections">>;
type _CarePlanLink = Conforms<Static<typeof CarePlanLinkResponseSchema>, Ret<"addCarePlanLink">>;
type _Evv = Conforms<Static<typeof EvvReconcileResponseSchema>, Ret<"documentEvvMissing">>;
type _Finalize = Conforms<Static<typeof FinalizeResponseSchema>, Ret<"finalize">>;
type _Enhance = Conforms<Static<typeof ModificationResponseSchema>, Ret<"enhanceHearthnote">>;
type _ModDecision = Conforms<
  Static<typeof ModificationResponseSchema>,
  Ret<"recordModificationDecision">
>;
type _Sign = Conforms<Static<typeof SignResponseSchema>, Ret<"sign">>;
type _LateEntry = Conforms<Static<typeof EncounterStatusResponseSchema>, Ret<"lateEntryOverride">>;
type _AdminOverride = Conforms<
  Static<typeof EncounterStatusResponseSchema>,
  Ret<"administrativeOverride">
>;
type _Void = Conforms<Static<typeof VoidResponseSchema>, Ret<"voidEncounter">>;
type _CosignRead = Conforms<Static<typeof CosignatureReadResponseSchema>, Ret<"getCosignature">>;
type _CosignAck = Conforms<
  Static<typeof CosignatureStatusResponseSchema>,
  Ret<"cosignAcknowledge">
>;
type _SupervisorRelease = Conforms<
  Static<typeof CosignatureStatusResponseSchema>,
  Ret<"supervisorRelease">
>;
type _CosignSign = Conforms<Static<typeof CosignSignResponseSchema>, Ret<"cosignSign">>;
type _CreateAddendum = Conforms<Static<typeof CreateAddendumResponseSchema>, Ret<"createAddendum">>;
type _AddendumSelections = Conforms<
  Static<typeof AddendumSelectionsResponseSchema>,
  Ret<"updateAddendumSelections">
>;
type _AddendumFinalize = Conforms<
  Static<typeof AddendumFinalizeResponseSchema>,
  Ret<"finalizeAddendum">
>;
type _AddendumSign = Conforms<Static<typeof AddendumSignResponseSchema>, Ret<"signAddendum">>;
type _Billable = Conforms<Static<typeof BillableResponseSchema>, Ret<"billable">>;
type _RenderPayload = Conforms<Static<typeof RenderPayloadResponseSchema>, Ret<"renderPayload">>;
type _SelectionsView = Conforms<Static<typeof SelectionsViewResponseSchema>, Ret<"getSelections">>;
type _AddendumSelectionsView = Conforms<
  Static<typeof SelectionsViewResponseSchema>,
  Ret<"getAddendumSelections">
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
