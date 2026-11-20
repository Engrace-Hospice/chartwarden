import { pageQuery, parse } from "@chartwarden/shared/route-kit";
import { CHART_PROMOTION_REJECT_REASONS, ENCOUNTER_VISIT_MODALITIES } from "@chartwarden/types";
// apps/backend/src/modules/08-encounters/routes/encounters-typebox.ts — M8-T09 TypeBox route schemas
// (§4.2). Named `encounters-typebox` (NOT `*schema*`) so the table-ownership import heuristic never
// mistakes a TypeBox import for a Drizzle one. Validation runs through TypeBox `Value` → M1's
// VALIDATION_FAILED envelope. Schemas mirror §4.2 (abbreviated where the spec spells out only the
// consequential routes). Optimistic concurrency rides the `If-Match` header (NOT the body); the sign
// routes carry the client's step-up timestamp (verified server-side ≤ 5 min stale, §2.7 D13).
import { type Static, Type } from "@sinclair/typebox";
import type {
  CreatedEncounter as ServiceCreatedEncounter,
  EncounterView as ServiceEncounterView,
  MileageResult as ServiceMileageResult,
  EncounterRouteService as ServiceRouteApi,
} from "./service";

export { parse };
// The vitals capture body and its responses live in their own file (vitals-typebox.ts); re-exported so the route and the OpenAPI
// enrichments keep importing them from here.
export {
  CaptureVitalsSchema,
  VitalsListResponseSchema,
  VitalsResultResponseSchema,
  VitalsViewResponseSchema,
} from "./vitals-typebox";

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

// §2.2 vocab mirrors (string-literal unions; the canonical types live in @chartwarden/types).
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
  "pt_visit",
  "ot_visit",
  "slp_visit",
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
  "pt",
  "ot",
  "slp",
] as const;

const Text = (min = 1, max = 4000) => Type.String({ minLength: min, maxLength: max });

/** The longest RFC 3339 date-time a clinician-entered visit time can be (`2026-05-05T10:00:00.123456789+05:30`
 *  is 35 characters); anything longer is not a time, so it is refused before parsing. */
const VISIT_INSTANT_MAX_LENGTH = 40;

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
  /** The visit's reason, chosen at the start of an unscheduled visit (a `visit_reason` code the pair is offered). */
  reasonCode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
});

/** The reasons for visit offered on one (encounter type × discipline) pair — read before the encounter exists. */
export const VisitReasonsQuerySchema = Type.Object({
  encounterType: lit(ENCOUNTER_TYPE),
  discipline: lit(ENCOUNTER_DISCIPLINE),
});

export const VisitReasonsResponseSchema = Type.Object({
  encounterType: lit(ENCOUNTER_TYPE),
  discipline: lit(ENCOUNTER_DISCIPLINE),
  reasons: Type.Array(Type.Object({ code: Type.String(), label: Type.String() })),
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
  /** A `@chartwarden/narrative-vocab` entry code; assembly rejects one that is not in the shipped corpus. */
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
  /**
   * The recorded fall (an M30 fall report for this patient) a follow-up-after-a-fall visit follows up. Absent keeps the link as it
   * is; null clears it. Only accepted while the reason for the visit is that follow-up.
   */
  fallIncidentId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  /**
   * The author's own edit of the note text. Absent keeps the edit as it is; null discards it so the note reads as generated; text is
   * stored beside the generated text, flagged, and is what gets signed.
   */
  editedNarrative: Type.Optional(
    Type.Union([Type.String({ minLength: 1, maxLength: 20_000 }), Type.Null()]),
  ),
});

const Int = Type.Optional(Type.Integer());
const NullableStr = Type.Union([Type.String(), Type.Null()]);

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

// GAP-013: a note documented > 24h after the visit must carry the clinician's own late-entry reason
// (>= 40 chars, §2.5/§2.7). The TIER is never a field — the server computes it from service_date.
export const FinalizeEncounterSchema = Type.Object({
  lateEntryReason: Type.Optional(Text(40)),
});

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
export const AttestationSchema = Type.Object({
  attestationConfirmed: Type.Literal(true),
  // GAP-013: supplied here only when the note slipped into a later tier between finalize and sign.
  lateEntryReason: Type.Optional(Text(40)),
});

/** The primary sign: the attestation plus how and when the visit happened (the cosignature and addendum
 *  signatures take only the {@link AttestationSchema}). */
export const SignEncounterSchema = Type.Composite([
  AttestationSchema,
  Type.Object({
    // How the visit was delivered. Required (422 MODALITY_CONFIRMATION_REQUIRED) for the Medicare-countable
    // disciplines unless the row already carries a confirmed modality.
    visitModality: Type.Optional(lit(ENCOUNTER_VISIT_MODALITIES)),
    // The clinician's documented visit bracket: the ACTUAL times, both or neither. Ignored when an M18 EVV
    // bracket exists (EVV always wins); never defaulted or padded server-side. Each needs an explicit UTC
    // offset (`Z` or `+hh:mm`) and the bracket may not exceed 8 hours (422 VISIT_TIME_INVALID, judged by
    // `visit-delivery.ts`); the length cap keeps the longest valid RFC 3339 value and nothing more.
    startedAt: Type.Optional(
      Type.String({ format: "date-time", maxLength: VISIT_INSTANT_MAX_LENGTH }),
    ),
    endedAt: Type.Optional(
      Type.String({ format: "date-time", maxLength: VISIT_INSTANT_MAX_LENGTH }),
    ),
  }),
]);

/** Confirm how an ALREADY-SIGNED visit was delivered (legacy rows signed before the modality column). */
export const ConfirmVisitModalitySchema = Type.Object({
  attestationConfirmed: Type.Literal(true),
  visitModality: lit(ENCOUNTER_VISIT_MODALITIES),
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
  /**
   * WP 3.7 (ADR-0063): author this addendum from a secure-message proposal. The reviewer still writes their OWN reason and
   * text; the quoted message is shown beside the editor, never inserted for them. Refused 422 PROMOTION_NOT_AVAILABLE
   * unless the proposal is open, for this encounter's patient, and visible to the caller.
   */
  promotionRequestId: Type.Optional(Type.String({ format: "uuid" })),
});

/** WP 3.7 - params of the reviewer routes on an encounter's chart promotions. */
export const ChartPromotionParamsSchema = Type.Object({
  encounterId: Type.String({ format: "uuid" }),
  requestId: Type.String({ format: "uuid" }),
});

/** WP 3.7 - params of the list route (the encounter id is a uuid: a malformed one is 422, never a database cast error). */
export const ChartPromotionListParamsSchema = Type.Object({
  encounterId: Type.String({ format: "uuid" }),
});

/** WP 3.7 - decline a proposal (the system-set reasons `requester` / `superseded` are not selectable here). */
export const RejectChartPromotionSchema = Type.Object(
  {
    reasonCode: Type.Union(CHART_PROMOTION_REJECT_REASONS.map((r) => Type.Literal(r))),
  },
  { additionalProperties: false },
);

// ── Queries ───────────────────────────────────────────────────────────────────────────────────────
export const EncounterListQuerySchema = Type.Object({
  patientId: Type.Optional(Type.String({ maxLength: 64 })),
  admissionId: Type.Optional(Type.String({ maxLength: 64 })),
  authorId: Type.Optional(Type.String({ maxLength: 64 })),
  status: Type.Optional(Type.String({ maxLength: 32 })),
  lateEntryTier: Type.Optional(Type.String({ maxLength: 32 })),
  from: Type.Optional(Type.String({ maxLength: 32 })),
  to: Type.Optional(Type.String({ maxLength: 32 })),
  ...pageQuery(),
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
  /** How the visit was delivered; null = unknown (never read as in person). */
  visitModality: Type.Optional(Type.Union([lit(ENCOUNTER_VISIT_MODALITIES), Type.Null()])),
  /** True once the clinician explicitly confirmed `visitModality` (a seeded value alone is false). */
  visitModalityConfirmed: Type.Optional(Type.Boolean()),
  /** Who supplied the documented start/end: the EVV bracket, or the signing clinician; null = none. */
  timeSource: Type.Optional(Type.Union([lit(["evv", "clinician"] as const), Type.Null()])),
  /** Single-read only: an M18 EVV bracket is on file for this visit (the sign ceremony then takes no typed times). */
  evvBracketPresent: Type.Optional(Type.Boolean()),
  selections: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
  finalDocumentation: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** True when `finalDocumentation` is the author's own edit of the generated note rather than the generated text. */
  finalDocumentationEdited: Type.Optional(Type.Boolean()),
  vitals: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
  mileage: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
  carePlanLinks: Type.Optional(
    Type.Array(
      Type.Object({
        linkId: Type.String(),
        problemId: Type.Union([Type.String(), Type.Null()]),
        goalId: Type.Union([Type.String(), Type.Null()]),
        interventionId: Type.Union([Type.String(), Type.Null()]),
      }),
    ),
  ),
  /** GAP-027 — the encounter's addenda, oldest first (single-read only). */
  addenda: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        status: lit(["draft", "finalized", "signed"] as const),
        reason: Type.String(),
        authoredByUserId: Type.String(),
        createdAt: Type.String(),
        signedAt: Type.Union([Type.String(), Type.Null()]),
        version: Type.Integer(),
      }),
    ),
  ),
});

/** The `{ encounters }` envelope the list / queue / signed-since reads return. */
export const EncounterListResponseSchema = Type.Object({
  encounters: Type.Array(EncounterViewResponseSchema),
});

/**
 * ADR-0113 — where one open note sits on the visit-note closure clock. `clockStartedAt` / `deadlineAt` are null for a legacy
 * draft that never got a clock (no backfill): it shows as "Legacy", never alerts and never blocks.
 */
export const NoteClosureViewResponseSchema = Type.Object({
  clockStartedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  deadlineAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  stage: lit(["ok", "at_risk", "overdue", "escalated"] as const),
});

/**
 * ADR-0113 — one row of "My notes" (`GET /encounters/my-drafts`): the list row plus its `closure`. A distinct shape: the shared
 * {@link EncounterViewResponseSchema} (list, queue, single read) does not carry it.
 */
export const MyNoteResponseSchema = Type.Composite([
  EncounterViewResponseSchema,
  Type.Object({ closure: NoteClosureViewResponseSchema }),
]);

/** The `{ encounters }` envelope "My notes" returns: the author's open notes (draft + finalized), nearest deadline first, legacy last. */
export const MyNotesResponseSchema = Type.Object({
  encounters: Type.Array(MyNoteResponseSchema),
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
  /** The visit's patient: attributes the read to them in the §164.528 accounting. */
  patientId: Type.String(),
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
  /** The author's edit of the note text, or null when the note reads as generated. Absent on an addendum's selections. */
  editedNarrative: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** True when the selections or vitals changed after the edit was made, so the edit needs the author's review before finalizing. */
  editedNarrativeStale: Type.Optional(Type.Boolean()),
  /** The recorded fall this visit is linked to, or null. Absent on an addendum's selections. */
  fallIncident: Type.Optional(
    Type.Union([
      Type.Object({ incidentId: Type.String(), occurredOn: Type.String({ format: "date" }) }),
      Type.Null(),
    ]),
  ),
});

/**
 * Route 3d — the patient's recorded falls this visit can follow up (WF09): id, the org-local date and the severity, never the report's
 * narrative. `unavailable` is true when Quality's incident register could not be read, so the screen can say so instead of claiming
 * the patient has no recorded fall.
 */
export const FallIncidentsResponseSchema = Type.Object({
  /** The visit's patient: attributes the read to them in the §164.528 accounting. */
  patientId: Type.String(),
  incidents: Type.Array(
    Type.Object({
      incidentId: Type.String(),
      occurredOn: Type.String({ format: "date" }),
      severity: Type.String(),
    }),
  ),
  unavailable: Type.Boolean(),
});

/** One slot's constraint, mirroring `SlotSpec` in `@chartwarden/narrative-vocab`. */
const SlotSpecSchema = Type.Union([
  Type.Object({
    kind: Type.Union([Type.Literal("integer"), Type.Literal("number")]),
    min: Type.Number(),
    max: Type.Number(),
    unit: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("choice"),
    options: Type.Array(Type.String()),
    label: Type.Optional(Type.String()),
  }),
]);

/**
 * Route 3c — the authoring MENU (F-063): the resolved HearthNote template with the vocabulary entries
 * each section accepts for this encounter's (type × discipline) pair.
 *
 * `slots` is what the client must supply as `params` on a selected entry — the phrase's `${…}`
 * placeholders minus the two the assembly context fills (`patient`, `serviceDate`). Derived from the
 * phrase rather than declared, so a corpus edit cannot leave the client asking for a slot that is gone.
 */
export const EncounterTemplateResponseSchema = Type.Object({
  encounterId: Type.String({ format: "uuid" }),
  templateKey: Type.String(),
  vocabVersion: Type.String(),
  encounterType: lit(ENCOUNTER_TYPE),
  discipline: lit(ENCOUNTER_DISCIPLINE),
  sections: Type.Array(
    Type.Object({
      sectionId: Type.String(),
      heading: Type.String(),
      /** A required section must carry ≥1 selection before the §2.6 Layer-3 gate lets the note finalize. */
      required: Type.Boolean(),
      /** The categories this section offers; empty means a prose-only section (`entries` is then empty). */
      allowedCategories: Type.Array(Type.String()),
      /** The structured record the composer offers in this section (ADLs, nutrition, wounds); null for a plain selection section. */
      recordedPanel: Type.Union([
        Type.Literal("adl"),
        Type.Literal("nutrition"),
        Type.Literal("wounds"),
        Type.Null(),
      ]),
      entries: Type.Array(
        Type.Object({
          code: Type.String(),
          label: Type.String(),
          category: Type.String(),
          bodySystem: Type.Union([Type.String(), Type.Null()]),
          slots: Type.Array(Type.String()),
          /** Per-slot constraint (a slot absent here is free text) — the composer renders its input from this. */
          slotSpecs: Type.Record(Type.String(), SlotSpecSchema),
          /** Statements sharing a group contradict each other; the server refuses two in one note. */
          exclusiveGroup: Type.Union([Type.String(), Type.Null()]),
        }),
      ),
    }),
  ),
});

/** Route 7b — the mileage row as recorded (F-063); `null` when none was captured. */
export const MileageViewResponseSchema = Type.Union([
  Type.Object({
    mileageId: Type.String(),
    encounterId: Type.String({ format: "uuid" }),
    odometerStart: Type.Union([Type.Integer(), Type.Null()]),
    odometerEnd: Type.Union([Type.Integer(), Type.Null()]),
    milesDriven: Type.String(),
    source: Type.String(),
    manualOverrideReason: Type.Union([Type.String(), Type.Null()]),
    routeProposedMiles: Type.Union([Type.String(), Type.Null()]),
    recordedAt: Type.String({ format: "date-time" }),
  }),
  Type.Null(),
]);

/**
 * Route 8 — the care-plan link, as created.
 *
 * F-064 (#159) — this was `{ linkId: string }`, and the value under that name was the ENCOUNTER's own
 * id: nothing was inserted, so there was no link id to return. The shape is the link now, and `id`
 * rather than `linkId` because a caller that stored the old field held an encounter id under a
 * link-shaped name and nothing distinguished it from a working create.
 */
export const CarePlanLinkResponseSchema = Type.Object({
  id: Type.String(),
  encounterId: Type.String(),
  problemId: NullableStr,
  goalId: NullableStr,
  interventionId: NullableStr,
  createdAt: Type.String(),
});

/** Route 8b — the live care-plan links on an encounter (F-064). Removed links are not projected. */
export const CarePlanLinkListResponseSchema = Type.Object({
  links: Type.Array(CarePlanLinkResponseSchema),
});

/** Route 10 — EVV-missing documented (D9 bracket state). */
export const EvvReconcileResponseSchema = Type.Object({ evvBracketState: Type.String() });

/** Route 11 — finalize (Layer-3 gate preview passed). */
export const FinalizeResponseSchema = Type.Object({
  status: Type.Literal("finalized"),
  version: Type.Integer(),
});

/** Route 13 — per-passage modification decision. A `modId` naming no `hearthnote_llm_modification`
 *  row is a 404, not an echo (#123). */
export const ModificationResponseSchema = Type.Object({ modificationId: Type.String() });

/** The §2.6 D5 eligibility ladder's verdicts (mirrors the `layer2_eligibility_reason` enum). */
const LAYER2_ELIGIBILITY_REASON = [
  "eligible",
  "tenant_flag_off",
  "clinician_opted_out",
  "encounter_type_excluded",
  "token_budget_exceeded",
  "baa_not_executed",
  "routing_preference_blocks_cloud",
  "kill_switch_active",
] as const;

/**
 * Route 12 — HearthNote Layer-2 enhancement.
 *
 * `enhanced` is published as the literal `false`, which is the point: the Layer-2 dispatch to M32's
 * `narrativeEnhancement` is unbuilt and the platform `hearthnote.layer2` flag is off, so this endpoint
 * never enhances anything today — and an integrator learns that from the contract rather than from the
 * source. `reason` carries the first D5 gate that refused; in Phase 1 that is always `kill_switch_active`.
 * The `enhanced: true` arm, with a real `hearthnote_llm_modification` id, is added when there is a code
 * path that can return it. There is deliberately no id here: the route used to answer 200 with the
 * ENCOUNTER's own id in a `modificationId` field (#123).
 */
export const HearthnoteEnhanceResponseSchema = Type.Object({
  enhanced: Type.Literal(false),
  reason: lit(LAYER2_ELIGIBILITY_REASON),
});

/** Route 14 — sign result (signed or routed to cosignature). */
export const SignResponseSchema = Type.Object({
  status: Type.Union([Type.Literal("signed"), Type.Literal("cosign_pending")]),
  signedAt: Type.String(),
  cosignatureRequestId: Type.Union([Type.String(), Type.Null()]),
});

/** Legacy-confirm route — the modality now on the (already signed) encounter and when it was confirmed. */
export const ConfirmVisitModalityResponseSchema = Type.Object({
  visitModality: lit(ENCOUNTER_VISIT_MODALITIES),
  visitModalityConfirmedAt: Type.String(),
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

/** WP 3.7 - one proposal waiting on the reviewer (snake_case, mirroring the M36 DTO). */
export const ChartPromotionViewSchema = Type.Object({
  request_id: Type.String({ format: "uuid" }),
  requested_by: Type.String({ format: "uuid" }),
  requested_at: Type.String({ format: "date-time" }),
  source_author_user_id: Type.String({ format: "uuid" }),
  source_sent_at: Type.String({ format: "date-time" }),
  snapshot_text: Type.Union([Type.String(), Type.Null()]),
  source_state: Type.Union([Type.Literal("current"), Type.Literal("edited_since")]),
});

/** WP 3.7 - GET /encounters/:encounterId/chart-promotions. */
export const ChartPromotionListResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  promotions: Type.Array(ChartPromotionViewSchema),
});

/** WP 3.7 - POST /encounters/:encounterId/chart-promotions/:requestId/reject. */
export const RejectChartPromotionResponseSchema = Type.Object({
  promotionRequestId: Type.String({ format: "uuid" }),
  outcome: Type.Literal("rejected"),
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
  /** The visit's patient: attributes the read to them in the §164.528 accounting. */
  patientId: Type.String(),
  final: Type.String(),
  /** True when `final` is the narrative pinned at finalize; false when it is a live re-assembly (#122). */
  pinned: Type.Boolean(),
  /** True when `final` is the author's own edit of the generated note (the generated text is kept beside it). */
  clinicianEdited: Type.Optional(Type.Boolean()),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Ret<K extends keyof ServiceRouteApi> = Awaited<ReturnType<ServiceRouteApi[K]>>;
type Conforms<T extends V, V> = T;
type _Created = Conforms<Static<typeof CreatedEncounterResponseSchema>, ServiceCreatedEncounter>;
type _View = Conforms<Static<typeof EncounterViewResponseSchema>, ServiceEncounterView>;
type _List = Conforms<Static<typeof EncounterListResponseSchema>, Ret<"listEncounters">>;
// F-063 — the two reads that had no counterpart write... the other way round: two WRITES that had no read.
type _Template = Conforms<Static<typeof EncounterTemplateResponseSchema>, Ret<"getTemplate">>;
type _MileageView = Conforms<Static<typeof MileageViewResponseSchema>, Ret<"getMileage">>;
type _Mileage = Conforms<Static<typeof MileageResultResponseSchema>, ServiceMileageResult>;
type _Selections = Conforms<Static<typeof SelectionsUpdateResponseSchema>, Ret<"updateSelections">>;
type _ChartPromotions = Conforms<
  Static<typeof ChartPromotionListResponseSchema>,
  Ret<"listChartPromotions">
>;
type _ChartPromotionReject = Conforms<
  Static<typeof RejectChartPromotionResponseSchema>,
  Ret<"rejectChartPromotion">
>;
type _CarePlanLink = Conforms<Static<typeof CarePlanLinkResponseSchema>, Ret<"addCarePlanLink">>;
type _CarePlanLinks = Conforms<
  Static<typeof CarePlanLinkListResponseSchema>,
  Ret<"listCarePlanLinks">
>;
type _Evv = Conforms<Static<typeof EvvReconcileResponseSchema>, Ret<"documentEvvMissing">>;
type _Finalize = Conforms<Static<typeof FinalizeResponseSchema>, Ret<"finalize">>;
type _Enhance = Conforms<Static<typeof HearthnoteEnhanceResponseSchema>, Ret<"enhanceHearthnote">>;
type _ModDecision = Conforms<
  Static<typeof ModificationResponseSchema>,
  Ret<"recordModificationDecision">
>;
type _Sign = Conforms<Static<typeof SignResponseSchema>, Ret<"sign">>;
type _ConfirmModality = Conforms<
  Static<typeof ConfirmVisitModalityResponseSchema>,
  Ret<"confirmVisitModality">
>;
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
