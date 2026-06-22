// apps/backend/src/modules/07-care-plan/routes/care-plan-typebox.ts — M7-T05 TypeBox route schemas
// (§4.3). Named `care-plan-typebox` (NOT `*schema*`) so the table-ownership import heuristic never
// mistakes a TypeBox import for a Drizzle one. Validation runs through TypeBox `Value` → M1's
// VALIDATION_FAILED envelope. Schemas mirror §4.3 1:1 (abbreviated where the spec is). Optimistic
// concurrency: the three PATCH routes carry the read version in the `If-Match` header (NOT the body —
// see ./concurrency.ts); the POST state-change routes carry it in the body as `ifVersion`.
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

// Slice ids are synthetic (`cp_1`); routes accept a loose id param. Cross-module ids (patientId) are
// validated as uuids per §4.3.
export const IdParamsSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });
export const PlanVersionParamsSchema = Type.Object({
  planId: Type.String({ minLength: 1, maxLength: 64 }),
  versionId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const PlanElementParamsSchema = Type.Object({
  planId: Type.String({ minLength: 1, maxLength: 64 }),
  elementId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const PatientParamsSchema = Type.Object({
  patientId: Type.String({ format: "uuid" }),
});
export const PlanParamsSchema = Type.Object({
  planId: Type.String({ minLength: 1, maxLength: 64 }),
});

const Text = (max = 4000) => Type.String({ minLength: 1, maxLength: max });
const Version = () => Type.Integer({ minimum: 1 });

const PROBLEM_KIND = ["terminal", "related", "unrelated"] as const;
const PROBLEM_SOURCE = [
  "clinical",
  "patient_reported",
  "family_reported",
  "history",
  "intake_extraction",
] as const;
const GOAL_SOURCE = ["clinical", "patient_stated", "family_stated", "agent_stated"] as const;
const INTERVENTION_DISCIPLINE = [
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
  "md_np",
  "pt",
  "ot",
  "st",
  "volunteer",
  "music_therapy",
  "dietitian",
  "bereavement",
] as const;
const VERSION_KIND = ["initial", "idg_review", "interim_revision", "discharge"] as const;
const SIGNER_ROLE = [
  "rn_case_manager",
  "hospice_physician",
  "nurse_practitioner",
  "msw",
  "chaplain",
  "medical_director",
] as const;

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

// ── Care plan bootstrap (route: POST /patients/:patientId/care-plan) ──────────────────────────────
export const BootstrapCarePlanSchema = Type.Object({
  admissionId: Type.String({ format: "uuid" }),
});

// ── Versions ──────────────────────────────────────────────────────────────────────────────────────
export const CreateVersionSchema = Type.Object({
  kind: lit(VERSION_KIND),
  idgMeetingId: Type.Optional(Type.String({ format: "uuid" })),
});
export const FinalizeVersionSchema = Type.Object({
  ifVersion: Version(),
  /** A tenant may tighten (add slots) the floor quorum; never loosen (validated server-side). */
  requiredSignerSet: Type.Optional(
    Type.Array(Type.Object({ role: lit(SIGNER_ROLE), count: Type.Integer({ minimum: 1 }) })),
  ),
});
export const SignVersionSchema = Type.Object({
  ifVersion: Version(),
  signerRole: lit(SIGNER_ROLE),
  patientUnderstandingText: Type.Optional(Type.String({ maxLength: 4000 })),
});
export const ReturnToDraftSchema = Type.Object({ ifVersion: Version() });

// ── Problems ────────────────────────────────────────────────────────────────────────────────────
export const CreateProblemSchema = Type.Object({
  icd10Code: Type.Optional(Type.String({ maxLength: 16 })),
  snomedCode: Type.Optional(Type.String({ maxLength: 32 })),
  description: Text(),
  kind: lit(PROBLEM_KIND),
  source: lit(PROBLEM_SOURCE),
  sudRelated: Type.Optional(Type.Boolean()),
  onsetAt: Type.Optional(Type.String({ format: "date-time" })),
});
export const PatchProblemSchema = Type.Object({
  description: Type.Optional(Text()),
  kind: Type.Optional(lit(PROBLEM_KIND)),
  icd10Code: Type.Optional(Type.String({ maxLength: 16 })),
  snomedCode: Type.Optional(Type.String({ maxLength: 32 })),
});
export const ResolveProblemSchema = Type.Object({
  ifVersion: Version(),
  resolutionNote: Text(),
});

// ── Goals ───────────────────────────────────────────────────────────────────────────────────────
export const CreateGoalSchema = Type.Object({
  problemId: Type.String({ minLength: 1, maxLength: 64 }),
  originalText: Text(),
  source: lit(GOAL_SOURCE),
  actingConsentId: Type.Optional(Type.String({ format: "uuid" })),
  measurableOutcome: Type.Optional(Type.String({ maxLength: 4000 })),
  targetAt: Type.Optional(Type.String({ format: "date-time" })),
});
export const PatchGoalSchema = Type.Object({
  revisedText: Type.Optional(Type.String({ maxLength: 4000 })),
  measurableOutcome: Type.Optional(Type.String({ maxLength: 4000 })),
  status: Type.Optional(
    lit(["not_started", "in_progress", "met", "not_met", "revised", "discontinued"] as const),
  ),
  targetAt: Type.Optional(Type.String({ format: "date-time" })),
});

// ── Interventions ───────────────────────────────────────────────────────────────────────────────
export const CreateInterventionSchema = Type.Object({
  problemId: Type.String({ minLength: 1, maxLength: 64 }),
  goalRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }))),
  scopeText: Text(),
  frequencyText: Type.String({ minLength: 1, maxLength: 200 }),
  frequencyValue: Type.String({ minLength: 1, maxLength: 64 }),
  discipline: lit(INTERVENTION_DISCIPLINE),
  responsibleRole: Type.Optional(Type.String({ maxLength: 64 })),
});
export const PatchInterventionSchema = Type.Object({
  scopeText: Type.Optional(Text()),
  frequencyText: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  frequencyValue: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  responsibleRole: Type.Optional(Type.String({ maxLength: 64 })),
});
export const DiscontinueInterventionSchema = Type.Object({
  ifVersion: Version(),
  reason: Text(),
});

// ── List queries ──────────────────────────────────────────────────────────────────────────────────
export const VersionListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
export const RelevantElementsQuerySchema = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  encounterType: Type.Optional(Type.String({ maxLength: 64 })),
  discipline: Type.Optional(Type.String({ maxLength: 64 })),
});

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
