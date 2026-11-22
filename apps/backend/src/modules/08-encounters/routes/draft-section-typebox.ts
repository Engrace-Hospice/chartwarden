// apps/backend/src/modules/08-encounters/routes/draft-section-typebox.ts — TypeBox request/response schemas for the visit-note draft and its
// section resolution (ADR-0114, PR C2b1). Named `*-typebox` (not `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox
// import for a Drizzle one. Validation runs through `parse` from encounters-typebox (M1's VALIDATION_FAILED envelope).
import { Type } from "@sinclair/typebox";

// ── requests ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const DraftParamsSchema = Type.Object({ encounterId: Type.String({ format: "uuid" }) });

export const DraftSectionParamsSchema = Type.Object({
  encounterId: Type.String({ format: "uuid" }),
  /** A template section id (`plan`, `vitals_review`, ...): lowercase snake case. */
  sectionId: Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }),
});

export const AmendmentDraftParamsSchema = Type.Object({
  encounterId: Type.String({ format: "uuid" }),
  addendumId: Type.String({ format: "uuid" }),
});

export const AmendmentSectionParamsSchema = Type.Object({
  encounterId: Type.String({ format: "uuid" }),
  addendumId: Type.String({ format: "uuid" }),
  /** A template section id the addendum names. */
  sectionId: Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }),
});

/** S4b (VN-D60): one element of the discipline's plan, named by its M15 id. */
export const DisciplinePlanElementParamsSchema = Type.Object({
  encounterId: Type.String({ format: "uuid" }),
  elementId: Type.String({ format: "uuid" }),
});

/** Keep the element in the visit's statement of the plan (`true`) or leave it out (`false`). Nothing else is read from the body: the viewer is the session. */
export const SetDisciplinePlanElementSchema = Type.Object(
  { included: Type.Boolean() },
  { additionalProperties: false },
);

/** What the clinician saw: the server recomputes the draft for the same viewer and refuses (409 DRAFT_SECTION_STALE) unless both still match. */
export const ResolveSectionSchema = Type.Object({
  resolution: Type.Union([Type.Literal("confirmed"), Type.Literal("deselected")]),
  /** The `contentHash` of the section as the draft returned it (64 lowercase hex characters). */
  contentHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  /** The `corpusVersion` of the section as the draft returned it. */
  corpusVersion: Type.String({ minLength: 1, maxLength: 64 }),
});

// ── responses ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SectionState = Type.Union([
  Type.Literal("not_drafted"),
  Type.Literal("unresolved"),
  Type.Literal("confirmed"),
  Type.Literal("deselected"),
  Type.Literal("needs_reconfirmation"),
]);

const Origin = Type.Union([
  Type.Literal("care_plan_goal"),
  Type.Literal("care_plan_intervention"),
  Type.Literal("scale_reading"),
  Type.Literal("vitals"),
  Type.Literal("medication_change"),
  // S2 (recertification and face-to-face visits): the kinds of the new sources. Kinds only, never ids (VN-D7).
  Type.Literal("weight_reading"),
  Type.Literal("benefit_period"),
  Type.Literal("face_to_face"),
  Type.Literal("certification"),
  // S2b (RN admission visit): the kinds of the new sources. Kinds only, never ids (VN-D7).
  Type.Literal("medication_order"),
  Type.Literal("caregiver"),
  Type.Literal("advance_directive_acknowledgment"),
  // S3 (aide visit): the visit's own recorded ADLs, which lead the drafted `adl` section. Kind only, never an id (VN-D7).
  Type.Literal("recorded_adl"),
  // S4 (social-work and chaplain visits): the goals and interventions of the discipline's own plan (M15). Kinds only, never ids (VN-D7).
  Type.Literal("discipline_plan_goal"),
  Type.Literal("discipline_plan_intervention"),
]);

/** S4b: the goals and interventions of the discipline's plan in effect at the visit, as the calling viewer is handed them, and whether the visit keeps each. */
export const DisciplinePlanElementsResponseSchema = Type.Object({
  /** The encounter's patient: the audited read is accountable against it. */
  patientId: Type.String({ format: "uuid" }),
  elements: Type.Array(
    Type.Object({
      elementId: Type.String({ format: "uuid" }),
      kind: Type.Union([Type.Literal("goal"), Type.Literal("intervention")]),
      /** The goal's words (the clinician's revision when there is one), or the intervention's scope and frequency. */
      text: Type.String(),
      /** Whether this visit keeps the element in its statement of the plan (false: left out). */
      kept: Type.Boolean(),
    }),
  ),
});

export const DraftSectionResponseSchema = Type.Object({
  sectionId: Type.String(),
  state: SectionState,
  /** The drafted text; null for a section with nothing to draft from (it is never filled with a default phrase). */
  text: Type.Union([Type.String(), Type.Null()]),
  /** What a confirmation of this section binds to; null for an empty section. */
  contentHash: Type.Union([Type.String(), Type.Null()]),
  corpusVersion: Type.Union([Type.String(), Type.Null()]),
  /** Whether any source behind the section may be 42 CFR Part 2 content (fails closed); null for an empty section. */
  part2Derived: Type.Union([Type.Boolean(), Type.Null()]),
  /** The kinds of record the section was built from, each once; never an id (the ids stay in the audit trail, VN-D7). */
  origins: Type.Array(Origin),
});

export const DraftResponseSchema = Type.Object({
  encounterId: Type.String(),
  patientId: Type.String(),
  templateKey: Type.String(),
  /** The visit time the draft describes the patient at (ISO-8601, UTC). */
  asOf: Type.String({ format: "date-time" }),
  /** Every section of the template, in template order. */
  sections: Type.Array(DraftSectionResponseSchema),
});

/** The draft of the signed note for an AMENDING addendum's author: the sections the addendum names only, each against the addendum's own resolutions. */
export const AmendmentDraftResponseSchema = Type.Object({
  addendumId: Type.String(),
  ...DraftResponseSchema.properties,
});
