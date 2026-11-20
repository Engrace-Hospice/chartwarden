// apps/backend/src/modules/09-assessments/wounds/wounds-typebox.ts — TypeBox schemas for the longitudinal wound routes.
// Named `*-typebox` (not `*schema*`) so the table-ownership import heuristic never mistakes it for a Drizzle import.
// Every `$id` starts with `Wound`. A malformed body is a 422 VALIDATION_FAILED (route-kit `parse`); the numeric BOUNDS and
// the cross-field rules are NOT here on purpose: they live in the domain (@chartwarden/assessments) so each broken rule
// answers with its own 422 code (WOUND_DEPTH_REQUIRES_AREA, WOUND_PAIN_RANGE, ...), not a generic one.
import {
  EXUDATE_AMOUNTS,
  EXUDATE_TYPES,
  PERIWOUND_CONDITIONS,
  PRESSURE_STAGES,
  WOUND_ACQUIRED,
  WOUND_BED_TISSUES,
  WOUND_CORRECTION_REASONS,
  WOUND_DRESSINGS,
  WOUND_ETIOLOGIES,
  WOUND_LATERALITIES,
  WOUND_OBSERVATION_STATUSES,
  WOUND_ODORS,
  WOUND_RESOLUTIONS,
  WOUND_SITE_CODES,
  WOUND_STATUSES,
  WOUND_TRENDS,
} from "@chartwarden/assessments";
import { parse } from "@chartwarden/shared/route-kit";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import type { WoundDetail, WoundListItem, WoundObservationDto, WoundView } from "./service";

export { parse };

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));
const nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const optionalNullable = <T extends TSchema>(s: T) => Type.Optional(nullable(s));
const NO_EXTRA = { additionalProperties: false } as const;

const SITE = lit(WOUND_SITE_CODES);
const LATERALITY = lit(WOUND_LATERALITIES);
const ETIOLOGY = lit(WOUND_ETIOLOGIES);
const ACQUIRED = lit(WOUND_ACQUIRED);
const STATUS = lit(WOUND_STATUSES);
const STAGE = lit(PRESSURE_STAGES);
const EXUDATE_AMOUNT = lit(EXUDATE_AMOUNTS);
const EXUDATE_TYPE = lit(EXUDATE_TYPES);
const ODOR = lit(WOUND_ODORS);
const DRESSING = lit(WOUND_DRESSINGS);
const TREND = lit(WOUND_TRENDS);
const BED = Type.Array(lit(WOUND_BED_TISSUES), { maxItems: WOUND_BED_TISSUES.length });
const PERIWOUND = Type.Array(lit(PERIWOUND_CONDITIONS), { maxItems: PERIWOUND_CONDITIONS.length });

// ── Path params and queries ──────────────────────────────────────────────────────────────────────────────────────
export const WoundPatientParamsSchema = Type.Object(
  { patientId: Type.String({ format: "uuid" }) },
  { ...NO_EXTRA, $id: "WoundPatientParams" },
);
export const WoundParamsSchema = Type.Object(
  { patientId: Type.String({ format: "uuid" }), woundId: Type.String({ format: "uuid" }) },
  { ...NO_EXTRA, $id: "WoundParams" },
);
export const WoundObservationParamsSchema = Type.Object(
  {
    patientId: Type.String({ format: "uuid" }),
    woundId: Type.String({ format: "uuid" }),
    observationId: Type.String({ format: "uuid" }),
  },
  { ...NO_EXTRA, $id: "WoundObservationParams" },
);
export const WoundListQuerySchema = Type.Object(
  { status: Type.Optional(Type.Union([lit(WOUND_STATUSES), Type.Literal("all")])) },
  { ...NO_EXTRA, $id: "WoundListQuery" },
);
export const WoundDetailQuerySchema = Type.Object(
  { includeSuperseded: Type.Optional(Type.Boolean()) },
  { ...NO_EXTRA, $id: "WoundDetailQuery" },
);

// ── Bodies ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const CreateWoundSchema = Type.Object(
  {
    siteCode: SITE,
    laterality: LATERALITY,
    etiology: ETIOLOGY,
    acquired: Type.Optional(ACQUIRED),
    onsetOn: optionalNullable(Type.String({ format: "date" })),
  },
  { ...NO_EXTRA, $id: "WoundCreate" },
);

const observationFields = {
  observedAt: Type.Optional(Type.String({ format: "date-time" })),
  /** The encounter this observation was recorded at (M8 visit note); a logical uuid, never a body-asserted org. */
  sourceEncounterId: optionalNullable(Type.String({ format: "uuid" })),
  stage: optionalNullable(STAGE),
  lengthCm: optionalNullable(Type.Number()),
  widthCm: optionalNullable(Type.Number()),
  depthCm: optionalNullable(Type.Number()),
  undermining: optionalNullable(Type.Boolean()),
  woundBed: Type.Optional(BED),
  exudateAmount: optionalNullable(EXUDATE_AMOUNT),
  exudateType: optionalNullable(EXUDATE_TYPE),
  odor: optionalNullable(ODOR),
  periwound: Type.Optional(PERIWOUND),
  painScore: optionalNullable(Type.Number()),
  dressing: optionalNullable(DRESSING),
  dressingChanged: optionalNullable(Type.Boolean()),
  infectionSigns: optionalNullable(Type.Boolean()),
  trend: optionalNullable(TREND),
};

export const RecordWoundObservationSchema = Type.Object(observationFields, {
  ...NO_EXTRA,
  $id: "WoundObservationRecord",
});

/** A correction restates the whole observation (it replaces the one it names) and says why, by code. */
export const CorrectWoundObservationSchema = Type.Object(
  { ...observationFields, correctionReason: lit(WOUND_CORRECTION_REASONS) },
  { ...NO_EXTRA, $id: "WoundObservationCorrect" },
);

export const ResolveWoundSchema = Type.Object(
  {
    status: lit(WOUND_RESOLUTIONS),
    /** Defaults to today (organisation-local). */
    closedOn: Type.Optional(Type.String({ format: "date" })),
  },
  { ...NO_EXTRA, $id: "WoundResolve" },
);

// ── Responses (pinned to the service views by the compile-time checks at the foot) ───────────────────────────────
export const WoundViewResponseSchema = Type.Object(
  {
    id: Type.String(),
    patientId: Type.String(),
    siteCode: SITE,
    laterality: LATERALITY,
    /** The display phrase for the location ("left heel"). */
    site: Type.String(),
    etiology: ETIOLOGY,
    acquired: ACQUIRED,
    onsetOn: nullable(Type.String()),
    status: STATUS,
    closedOn: nullable(Type.String()),
    createdAt: Type.String(),
  },
  { $id: "WoundView" },
);

export const WoundObservationResponseSchema = Type.Object(
  {
    id: Type.String(),
    woundId: Type.String(),
    patientId: Type.String(),
    observedAt: Type.String(),
    observedByMembershipId: Type.String(),
    sourceEncounterId: nullable(Type.String()),
    stage: nullable(STAGE),
    lengthCm: nullable(Type.Number()),
    widthCm: nullable(Type.Number()),
    depthCm: nullable(Type.Number()),
    undermining: nullable(Type.Boolean()),
    woundBed: Type.Array(lit(WOUND_BED_TISSUES)),
    exudateAmount: nullable(EXUDATE_AMOUNT),
    exudateType: nullable(EXUDATE_TYPE),
    odor: nullable(ODOR),
    periwound: Type.Array(lit(PERIWOUND_CONDITIONS)),
    painScore: nullable(Type.Integer()),
    dressing: nullable(DRESSING),
    dressingChanged: nullable(Type.Boolean()),
    infectionSigns: nullable(Type.Boolean()),
    trend: nullable(TREND),
    status: lit(WOUND_OBSERVATION_STATUSES),
    correctsObservationId: nullable(Type.String()),
    correctionReason: nullable(lit(WOUND_CORRECTION_REASONS)),
    version: Type.Integer(),
    createdAt: Type.String(),
    /** Computed for display, never stored: length x width, cm^2. */
    areaCm2: nullable(Type.Number()),
    /** Percent change of the area since the last earlier measured observation; negative = smaller. */
    areaChangePercent: nullable(Type.Number()),
    areaChangeSinceObservedAt: nullable(Type.String()),
  },
  { $id: "WoundObservation" },
);

export const WoundListItemResponseSchema = Type.Object(
  {
    ...WoundViewResponseSchema.properties,
    latestObservation: nullable(WoundObservationResponseSchema),
  },
  { $id: "WoundListItem" },
);

export const WoundListResponseSchema = Type.Object(
  { wounds: Type.Array(WoundListItemResponseSchema) },
  { $id: "WoundListResponse" },
);

export const WoundDetailResponseSchema = Type.Object(
  {
    wound: WoundViewResponseSchema,
    /** Newest first. */
    observations: Type.Array(WoundObservationResponseSchema),
  },
  { $id: "WoundDetailResponse" },
);

// Compile-time pins: what the schema publishes must be assignable to what the service returns (a view field added or
// renamed breaks the build rather than drifting from the generated client).
type Pinned<T extends V, V> = T;
type _WoundView = Pinned<Static<typeof WoundViewResponseSchema>, WoundView>;
type _WoundObservation = Pinned<Static<typeof WoundObservationResponseSchema>, WoundObservationDto>;
type _WoundListItem = Pinned<Static<typeof WoundListItemResponseSchema>, WoundListItem>;
type _WoundDetail = Pinned<Static<typeof WoundDetailResponseSchema>, WoundDetail>;
export type WoundTypeboxPins = [_WoundView, _WoundObservation, _WoundListItem, _WoundDetail];
