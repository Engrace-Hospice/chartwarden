// apps/backend/src/modules/08-encounters/findings/findings-typebox.ts — WF09: the TypeBox schemas of the findings routes
// (ADLs, nutrition, weight history). Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a
// TypeBox import for a Drizzle one. Every value set is built from the @chartwarden/hearthnote constants, the one source of truth
// for the stored values, the API and the screens. `$id`s are prefixed `Findings` so they cannot clash with another module's
// schema in the generated OpenAPI document.
import {
  ADL_DEVICES,
  ADL_ITEMS,
  ADL_LEVELS,
  APPETITE_LEVELS,
  type AdlItem,
  CONTINENCE_LEVELS,
  FLUID_INTAKE_LEVELS,
  NUTRITION_SUPPORTS,
  SWALLOWING_LEVELS,
} from "@chartwarden/hearthnote";
import { ValidationError } from "@chartwarden/types";
import { type Static, type TOptional, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AdlView, NutritionView } from "./findings-service";
import type { WeightHistoryView, WeightReading } from "./weight-history";

/**
 * Validate a JSON request BODY exactly as sent. The route kit's `parse` first runs `Value.Convert`, which is right for a query
 * string but wrong here: it would store `12.5` percent as 12 and wrap `"cane"` into `["cane"]`, accepting a body the clinician
 * did not write. A missing body is a 422 too, since a PUT replaces the whole record and an empty one must be sent as `{}`.
 */
export function parseBody<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  if (raw === undefined || raw === null || !Value.Check(schema, raw)) {
    const first = raw === undefined || raw === null ? undefined : Value.Errors(schema, raw).First();
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "a JSON object body is required" },
    ]);
  }
  return raw as Static<T>;
}

const lit = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

const AdlLevelSchema = lit(ADL_LEVELS);
const ContinenceSchema = lit(CONTINENCE_LEVELS);

/** Every ADL item as an optional key; the same shape for the body (an item may be null) and the view (unassessed items are absent). */
const adlItems = <V extends TSchema>(value: V) =>
  Type.Object(
    Object.fromEntries(ADL_ITEMS.map((item) => [item, Type.Optional(value)])) as unknown as {
      [K in AdlItem]: TOptional<V>;
    },
    { additionalProperties: false },
  );

export const FindingsEncounterParamsSchema = Type.Object(
  { encounterId: Type.String({ format: "uuid" }) },
  { $id: "FindingsEncounterParams" },
);

/** `PUT .../adl` — replaces the whole record; an absent or null field is "not assessed". */
export const FindingsAdlInputSchema = Type.Object(
  {
    items: Type.Optional(adlItems(nullable(AdlLevelSchema))),
    bladder: Type.Optional(nullable(ContinenceSchema)),
    bowel: Type.Optional(nullable(ContinenceSchema)),
    devices: Type.Optional(Type.Array(lit(ADL_DEVICES), { maxItems: ADL_DEVICES.length })),
  },
  { $id: "FindingsAdlInput", additionalProperties: false },
);

/** `GET|PUT .../adl` — the stored record (`null` on GET when none was recorded). */
export const FindingsAdlViewSchema = Type.Object(
  {
    encounterId: Type.String({ format: "uuid" }),
    patientId: Type.String({ format: "uuid" }),
    version: Type.Integer({ minimum: 0 }),
    items: adlItems(AdlLevelSchema),
    bladder: nullable(ContinenceSchema),
    bowel: nullable(ContinenceSchema),
    devices: Type.Array(lit(ADL_DEVICES)),
    updatedAt: Type.String({ format: "date-time" }),
  },
  { $id: "FindingsAdlView" },
);
export const FindingsAdlResponseSchema = Type.Union([FindingsAdlViewSchema, Type.Null()], {
  $id: "FindingsAdlResponse",
});

/** `PUT .../nutrition` — replaces the whole record; an absent or null field is "not assessed". */
export const FindingsNutritionInputSchema = Type.Object(
  {
    appetite: Type.Optional(nullable(lit(APPETITE_LEVELS))),
    mealIntakePercent: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
    ),
    fluidIntake: Type.Optional(nullable(lit(FLUID_INTAKE_LEVELS))),
    swallowing: Type.Optional(nullable(lit(SWALLOWING_LEVELS))),
    support: Type.Optional(nullable(lit(NUTRITION_SUPPORTS))),
  },
  { $id: "FindingsNutritionInput", additionalProperties: false },
);

/** `GET|PUT .../nutrition` — the stored record (`null` on GET when none was recorded). */
export const FindingsNutritionViewSchema = Type.Object(
  {
    encounterId: Type.String({ format: "uuid" }),
    patientId: Type.String({ format: "uuid" }),
    version: Type.Integer({ minimum: 0 }),
    appetite: nullable(lit(APPETITE_LEVELS)),
    mealIntakePercent: Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
    fluidIntake: nullable(lit(FLUID_INTAKE_LEVELS)),
    swallowing: nullable(lit(SWALLOWING_LEVELS)),
    support: nullable(lit(NUTRITION_SUPPORTS)),
    updatedAt: Type.String({ format: "date-time" }),
  },
  { $id: "FindingsNutritionView" },
);
export const FindingsNutritionResponseSchema = Type.Union(
  [FindingsNutritionViewSchema, Type.Null()],
  { $id: "FindingsNutritionResponse" },
);

/** One recorded weight: the value as stored, the unit it was recorded in, and the service date it was taken on. */
export const FindingsWeightReadingSchema = Type.Object(
  {
    value: Type.String(),
    unit: Type.String(),
    on: Type.String({ format: "date" }),
  },
  { $id: "FindingsWeightReading" },
);

/** `GET .../weight-history` */
export const FindingsWeightHistoryResponseSchema = Type.Object(
  {
    patientId: Type.String({ format: "uuid" }),
    /** This visit holds a weight with no usable unit (kg|lb): it is left out of the history and the note; re-enter it with its unit. */
    weightUnitMissing: Type.Boolean(),
    current: Type.Union([FindingsWeightReadingSchema, Type.Null()]),
    prior: Type.Union([FindingsWeightReadingSchema, Type.Null()]),
    history: Type.Array(FindingsWeightReadingSchema),
  },
  { $id: "FindingsWeightHistoryResponse" },
);

// Compile-time pins: what the schema publishes and what the service returns must be mutually assignable.
type Agree<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type FindingsSchemaPins = [
  Assert<Agree<Static<typeof FindingsAdlViewSchema>, AdlView>>,
  Assert<Agree<Static<typeof FindingsNutritionViewSchema>, NutritionView>>,
  Assert<Agree<Static<typeof FindingsWeightReadingSchema>, WeightReading>>,
  Assert<Agree<Static<typeof FindingsWeightHistoryResponseSchema>, WeightHistoryView>>,
];
