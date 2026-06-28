// @wardenx/types — Module 8 (Encounters & Visit Notes) leaf contracts (M8-T01).
//
// Per ADR-0005 D1 the cross-module CONTRACTS live in this leaf package (the M8 spec's references to
// `packages/domain/encounter/*` and `packages/types/events/encounter.ts` resolve here — there is no
// domain/foundation package on the cross-module read path; architecture wins). M8-T01 ships the
// type-level surface every later M8 task + every cross-module consumer builds on: the §3.2 pgEnum
// value mirrors, the §2.2 encounter-type × discipline legal-pair matrix (consumed by the T04 sync
// validator), the §3.1/§2.2 audit denylists (the M4 trigger arguments for M8-T02/T03), the §4.4
// `m8.*` outbox event names, and the §4.7 reader seams M14/M22/M23/M24 consume. The seam
// IMPLEMENTATIONS + their M1-registry wiring land in M8-T08; routes in M8-T09; the full outbox
// publication in M8-T11.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so
// the package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ─
import type { AdmissionId, DateRange, LocalDate, PatientId } from "./admission";
import type { IsoInstant, MembershipId } from "./care-plan";

// ── Encounter-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @wardenx/db) ──
export type EncounterId = string;
export type EncounterAddendumId = string;
export type EncounterSignatureId = string;
export type EncounterCarePlanLinkId = string;
export type CosignatureRequestId = string;
export type VitalsId = string;
export type MileageId = string;
export type HearthnoteSelectionId = string;
export type HearthnoteAssembledOutputId = string;
export type HearthnoteLlmModificationId = string;
/** A M17 visit id (logical/soft-ref; M17 is Wave F — nullable for ad-hoc encounters, §3.3). */
export type VisitId = string;
/** A M38 code-system version id pinned at first finalize (logical soft-ref, D11). */
export type VocabVersionId = string;

// ── §3.2 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ────────────────────

/** The 14 §2.2 visit types (mirrors `encounter_type`). */
export type EncounterType =
  | "routine_visit"
  | "admission_visit"
  | "recert_visit"
  | "face_to_face"
  | "telephonic"
  | "lpn_visit"
  | "chha_visit"
  | "msw_assessment"
  | "msw_followup"
  | "chaplain_assessment"
  | "chaplain_visit"
  | "volunteer_visit"
  | "bereavement_contact"
  | "idg_followup";

/** The §2.2 authoring/signing discipline (mirrors `encounter_discipline`). */
export type EncounterDiscipline =
  | "rn"
  | "lpn"
  | "chha"
  | "msw"
  | "chaplain"
  | "volunteer"
  | "md"
  | "np";

/** The §2.3 encounter lifecycle (mirrors `encounter_status`). */
export type EncounterStatus =
  | "draft"
  | "finalized"
  | "signed"
  | "cosign_pending"
  | "cosigned"
  | "voided";

/** The §2.5 D4 late-entry tier (mirrors `late_entry_tier`). */
export type LateEntryTier =
  | "normal"
  | "late_entry"
  | "significant_late_entry"
  | "administrative_override";

/** Which signature slot an `encounter_signature` row fills (mirrors `signature_kind`). */
export type SignatureKind = "primary" | "cosignature" | "addendum";

/** The step-up method used to authenticate a sign (mirrors `signature_method`, D13). */
export type SignatureMethod = "passkey" | "biometric" | "password_plus_otp";

/** The §2.4 D3 cosignature-request lifecycle (mirrors `cosignature_status`). */
export type CosignatureStatus =
  | "pending"
  | "routed"
  | "acknowledged"
  | "escalated"
  | "hard_cap_reached"
  | "supervisor_released"
  | "signed";

/** The unit a vitals measurement is captured in (mirrors `vital_unit`). */
export type VitalUnit =
  | "mmHg"
  | "bpm"
  | "breaths_per_min"
  | "c"
  | "f"
  | "percent_o2"
  | "kg"
  | "lb"
  | "cm"
  | "in"
  | "mg_dl"
  | "mmol_l";

/** The validated pain instrument used for a vitals row (mirrors `pain_scale`). */
export type PainScale = "nrs_0_10" | "flacc" | "painad" | "verbal_descriptor";

/** Whether EVV bracketed the visit or the gap is documented (mirrors `evv_bracket_state`, §2.7 D9). */
export type EvvBracketState = "evv_present" | "evv_missing_documented";

/** Why the HearthNote Layer-2 LLM path is (in)eligible (mirrors `layer2_eligibility_reason`; the
 * cloud path stays INELIGIBLE until M32's BAA+ZDR gate passes — M08-F01 / ADR-0012 D4). */
export type Layer2EligibilityReason =
  | "eligible"
  | "tenant_flag_off"
  | "clinician_opted_out"
  | "encounter_type_excluded"
  | "token_budget_exceeded"
  | "baa_not_executed"
  | "routing_preference_blocks_cloud"
  | "kill_switch_active";

/** A clinician's per-passage decision on a Layer-2 modification (mirrors `layer2_passage_decision`). */
export type Layer2PassageDecision = "accept" | "edit" | "reject";

/** Whether an assembled-output row is a primary or addendum finalize (mirrors `assembled_output_kind`). */
export type AssembledOutputKind = "primary_finalize" | "addendum_finalize";

// ── §2.2 encounter-type × discipline legal-pair matrix (declared as data) ───────────────────────────
// "Not every (encounter_type × discipline) combination is valid; the template engine declares legal
// pairs." Captured here as the single source the M8-T04 sync validator + HearthNote template engine
// read; an illegal pair is rejected at draft creation with `422 INVALID_ENCOUNTER_DISCIPLINE_PAIR`
// (§2.7). The spec's explicit floors hold (`face_to_face` ⇒ md|np, `chha_visit` ⇒ chha,
// `routine_visit` ⇒ rn|lpn, `lpn_visit` ⇒ lpn); discipline-named types pin to their discipline; the
// shared/clinical types admit the clinical disciplines their §2.2 notes describe.

/** Per encounter-type, the disciplines that may author/sign it (§2.2). */
export const ENCOUNTER_DISCIPLINE_RULES: {
  readonly [K in EncounterType]: readonly EncounterDiscipline[];
} = {
  routine_visit: ["rn", "lpn"],
  admission_visit: ["rn"],
  recert_visit: ["rn"],
  face_to_face: ["md", "np"],
  telephonic: ["rn", "lpn", "msw", "chaplain", "md", "np"],
  lpn_visit: ["lpn"],
  chha_visit: ["chha"],
  msw_assessment: ["msw"],
  msw_followup: ["msw"],
  chaplain_assessment: ["chaplain"],
  chaplain_visit: ["chaplain"],
  volunteer_visit: ["volunteer"],
  bereavement_contact: ["msw", "chaplain", "volunteer"],
  idg_followup: ["rn", "lpn", "msw", "chaplain", "md", "np"],
} as const;

/** §2.2 — whether a `(encounterType, discipline)` pair is legal (the T04 validator's predicate). */
export function isValidEncounterDisciplinePair(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
): boolean {
  return ENCOUNTER_DISCIPLINE_RULES[encounterType].includes(discipline);
}

// ── §3.1 / §2.2 per-entity audit denylists (the free-text/PHI columns the M4 trigger must NOT mirror) ─
// Captured here as data so M8-T03's `generateAuditTrigger(...)` denylist arguments derive from a
// single source rather than being re-typed per table. Free-text reason/narrative columns and the
// encrypted HearthNote cipher/diff columns are denylisted from value capture (§8.1: the trigger
// records that a write happened and a `<changed>` marker, never the PHI value). Structured numerics,
// enums, ids, and the boilerplate attestation text are kept (the M6 convention). Tables with no
// sensitive free-text are listed `[]`.

/** The M8 table names that own a write-audit trigger (one per §3.3 owned table). */
export type M8TableName =
  | "encounter"
  | "encounter_addendum"
  | "encounter_signature"
  | "encounter_care_plan_link"
  | "cosignature_request"
  | "vitals"
  | "mileage"
  | "hearthnote_selection"
  | "hearthnote_assembled_output"
  | "hearthnote_llm_modification";

/** Per-table audit denylist (§3.1 / §8.1). Empty array = no free-text PHI on that table. */
export const M8_AUDIT_DENYLIST: { readonly [K in M8TableName]: readonly string[] } = {
  encounter: [
    "evv_missing_reason",
    "late_entry_reason",
    "significant_late_override_reason",
    "administrative_override_reason",
    "voided_reason",
  ],
  encounter_addendum: ["reason"],
  encounter_signature: [],
  encounter_care_plan_link: [],
  cosignature_request: ["supervisor_released_reason"],
  vitals: ["clinically_not_indicated_reason"],
  mileage: ["manual_override_reason"],
  hearthnote_selection: ["free_text_cipher"],
  hearthnote_assembled_output: ["layer1_cipher", "layer2_cipher", "final_cipher"],
  hearthnote_llm_modification: ["diff_json", "per_passage_decisions"],
} as const;

// ── §4.4 outbox event names (the `m8.*` namespace the dispatcher + arch:gaps catalog validate) ───────

/** The full §4.4 M8 outbox taxonomy, in subscriber-facing `m8.*` form. The system keys off
 * `m8.encounter.signed` (M9/M10/M14/M22/M28/M30/M31/M33/M36), the `m8.encounter.cosignature_*` SLA
 * chain (M36/M33), and the late-entry overrides (M30/M33). The full set is published in M8-T11. */
export const M8_EVENT_NAMES = [
  "m8.encounter.created",
  "m8.encounter.finalized",
  "m8.encounter.signed",
  "m8.encounter.cosigned",
  "m8.encounter.addendum_signed",
  "m8.encounter.cosignature_routed",
  "m8.encounter.cosignature_overdue",
  "m8.encounter.cosignature_escalated",
  "m8.encounter.cosignature_hard_cap_reached",
  "m8.encounter.late_entry_override",
  "m8.encounter.administrative_override",
  "m8.encounter.voided",
  "m8.encounter.orphan_recorded",
  "m8.hearthnote.layer2_enhanced",
  "m8.vitals.captured",
  "m8.mileage.captured",
] as const;

/** An M8 outbox event name (§4.4). */
export type M8EventName = (typeof M8_EVENT_NAMES)[number];

// ── §4.7 owned-seam DTOs (read-only projections; never Drizzle rows) ─────────────────────────────────

/** A lightweight signed-encounter row for the M14 IDG aggregator (§4.7 `SignedEncountersReader`). */
export interface SignedEncounterDigest {
  readonly encounterId: EncounterId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  readonly serviceDate: string;
  readonly signedAt: IsoInstant;
  readonly signedByMembershipId: MembershipId;
  readonly lateEntryTier: LateEntryTier;
  readonly status: EncounterStatus;
  /** The §2.7 EVV bracket the visit finalized with (`evv_present` when both ends are EVV-verified, D9). HVLDL
   * counts only `evv_present` qualifying-discipline visits; the M8 Drizzle reader populates it from the
   * `encounter.evv_bracket_state` column. Additive — existing consumers ignore the field. */
  readonly evvBracketState: EvvBracketState;
}

/** A signed addendum projection inside an {@link EncounterRenderPayload}. */
export interface EncounterAddendumRender {
  readonly addendumId: EncounterAddendumId;
  readonly reason: string;
  readonly text: string;
  readonly signedAt: IsoInstant;
}

/** The render payload M22 (PDF) + M28 (FHIR) read for a signed encounter (§4.4 `documentRenderPayload`,
 * §4.7 `renderPayloadFor`). The `final` bytes ARE the signed narrative; addenda are appended in order. */
export interface EncounterRenderPayload {
  readonly encounterId: EncounterId;
  readonly final: string;
  readonly addenda: ReadonlyArray<EncounterAddendumRender>;
}

/** Why an encounter is not yet billable (§4.7 `BillableEncounterReader`). */
export type NotBillableReason =
  | "awaiting_cosignature"
  | "voided"
  | "volunteer_non_billable"
  | "late_entry_unattested";

/** One billability verdict for a single encounter (§4.7). */
export interface EncounterBillability {
  readonly encounterId: EncounterId;
  readonly billable: boolean;
  readonly reason?: NotBillableReason;
}

// ── §4.7 seams M8 OWNS and publishes (consumed by downstream modules; impls + wiring land in M8-T08) ─

/**
 * §4.7 — per-encounter billability for M23/M24 claim-line construction. Returns `billable:false,
 * reason:'awaiting_cosignature'` from primary sign through transition to `cosigned` (§2.4) so the
 * claim engine holds the visit out of assembly. Resolved within the caller's tenant context.
 */
export interface BillableEncounterReader {
  billability(
    encounterIds: ReadonlyArray<EncounterId>,
  ): Promise<ReadonlyArray<EncounterBillability>>;
}

/**
 * §4.7 — the signed-encounter read surface the M14 IDG aggregator + M22 PDF render consume.
 * `signedEncountersForPatientSince` returns lightweight digests; `renderPayloadFor` returns the
 * decrypted narrative payload for a single encounter. Resolved within the caller's tenant context.
 */
export interface SignedEncountersReader {
  signedEncountersForPatientSince(
    organizationId: string,
    patientId: PatientId,
    since: IsoInstant,
  ): Promise<ReadonlyArray<SignedEncounterDigest>>;

  renderPayloadFor(encounterId: EncounterId): Promise<EncounterRenderPayload>;
}

/**
 * §4.7 — internal marker the M1 outbox dispatcher uses to type-check M8 subscribers. M8 performs no
 * direct cross-module calls at the boundary; all downstream communication is the `m8.*` outbox (§2.8).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export type EncounterEventPublisher = Record<string, never>;

/** One per-encounter mileage row M27 payroll/AP reads (§4.5 D10). */
export interface MileagePayrollRow {
  readonly mileageId: MileageId;
  readonly encounterId: EncounterId;
  readonly clinicianMembershipId: MembershipId;
  readonly serviceDate: LocalDate;
  /** The AUTHORITATIVE miles M8 stores (odometer-computed or `miles_driven_override`), never M17's. */
  readonly milesDriven: number;
}

/**
 * §4.7 (forward seam) — the per-clinician mileage read surface M27 payroll/AP + tenant payroll
 * integrations consume (§4.5 D10): payroll reads the authoritative `miles_driven` from M8's `mileage`
 * table, NEVER from M17 route optimization. Resolved within the caller's tenant context (RLS-scoped).
 */
export interface MileagePayrollReader {
  mileageForPayrollPeriod(
    clinicianMembershipId: MembershipId,
    range: DateRange,
  ): Promise<ReadonlyArray<MileagePayrollRow>>;
}

/** The fields an upstream module supplies to open a draft encounter through {@link EncounterCreator}. */
export interface CreateEncounterInput {
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  readonly serviceDate: LocalDate;
  readonly authorMembershipId: MembershipId;
  /** The M17 visit this encounter brackets, or null for an ad-hoc contact (§3.3). */
  readonly visitId?: VisitId | null;
}

/**
 * §4.7 (forward seam) — opens a DRAFT encounter on behalf of an upstream module that reuses the M8
 * model without importing M8's schema: M16 bereavement (post-death contacts) and M17 visit-seeding.
 * The created encounter enters the normal §2.3 lifecycle (authoring/signing happen through M8's own
 * routes); the creator only mints the draft row. Resolved within the caller's tenant context.
 */
export interface EncounterCreator {
  createDraftEncounter(input: CreateEncounterInput): Promise<{ encounterId: EncounterId }>;
}

// ── §4.7 seam M8 CONSUMES from M18 (EVV) — forward seam, deny-stub until M18 lands (D9) ──────────────

/**
 * The EVV bracket M18 resolves for an encounter's visit (§2.7 / §7.8 D9). When EVV check-in/out events
 * exist, the timestamps are AUTHORITATIVE — `startedAt`/`endedAt` are read-only and clinician-entered
 * times do not override (D9). When no events exist, the resolver returns null and M8's EVV-missing path
 * (`evv_missing_reason` ≥20 chars → `evv_missing_documented`) becomes operative.
 */
export interface EvvBracketResolution {
  /** The M18 `evv_event` id for the check-in (logical FK carried on `encounter.evv_check_in_event_id`). */
  readonly checkInEventId: string | null;
  /** The M18 `evv_event` id for the check-out (logical FK on `encounter.evv_check_out_event_id`). */
  readonly checkOutEventId: string | null;
  /** Authoritative EVV check-in instant (ISO), or null when no check-in event is present. */
  readonly startedAt: IsoInstant | null;
  /** Authoritative EVV check-out instant (ISO), or null when no check-out event is present. */
  readonly endedAt: IsoInstant | null;
  /** The bracket state finalize reifies onto the encounter (`evv_present` when both ends are present). */
  readonly bracketState: EvvBracketState;
}

/**
 * §4.7 (forward seam, CONSUMED from M18) — resolves the EVV bracket for an encounter's visit at
 * finalize (D9). M18 (EVV) owns `evv_event` + the geofence/aggregator math; M8 only READS the bracket
 * (never writes EVV). Registered in the M1 seam registry with a fail-closed deny-stub until M18 lands
 * (Wave F); M8's EVV-missing-documented fallback path stays operative in the meantime (route 10).
 * Leaf-typed in @wardenx/types (not @wardenx/evv) so M8 consumes it with no `dependsOn` edge to M18.
 */
export interface EvvBracketResolver {
  resolveBracket(input: {
    organizationId: string;
    visitId: VisitId;
  }): Promise<EvvBracketResolution | null>;
}
