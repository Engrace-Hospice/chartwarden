// apps/backend/src/modules/08-encounters/routes/service.ts — M8-T09 the EncounterRouteService + an
// in-memory slice (§4.1). The route handlers compose over this; production injects a Drizzle-backed
// service (writes under `withOrgContext` so RLS scopes by `app.org_id`). The slice also exposes an
// EncounterAbacResolver over the SAME dataset so M8's §4.6 `m8.cosigner_role_match` predicate resolves an
// encounter's author/discipline without a cross-module schema import. Mirrors the M6/M7 routes/service.ts
// precedent: pure-ish (no clock except the injected `now()` so version/sign timestamps are deterministic
// in tests), every guard failure surfaces as an `EncounterStateError` (the §2.7 code → HTTP map).
//
// SCOPE (T09): the route inventory + the §4.5 RBAC gating + the §4.6 cosigner predicate. The heavier
// authoring surfaces (vitals/mileage, the F2F dual-write happy path) land in M8-T10; here they are lean
// success handlers over the same optimistic-locked records so the inventory is wired and smoke-tested.
import {
  type AssemblyContext,
  HearthnoteAssemblyError,
  type SelectionState,
  assemble,
  templateKey as hearthnoteTemplateKey,
  requiredScalesFor,
  requiredVitalsFor,
  resolveTemplate,
} from "@wardenx/hearthnote";
import { VOCAB_VERSION, activeNarrativeVocabRelease, entriesFor } from "@wardenx/narrative-vocab";
import type {
  EncounterDiscipline,
  EncounterStatus,
  EncounterType,
  LocalDate,
} from "@wardenx/types";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@wardenx/types";
import {
  type F2fAttestationWrite,
  type MileageInput,
  type VitalsInput,
  assertAtLeastOneCarePlanRef,
  deriveAbnormalFlags,
  planF2fDualWrite,
  planMileageCapture,
  planVitalsCapture,
} from "../authoring/index";
import {
  type AddendumPromotionInput,
  CHART_PROMOTION_DECIDED_EVENT,
  type ChartPromotionListView,
  type RejectReasonCode,
  decidedPayload,
  listForPatient,
  requireReview,
} from "../chart-promotion";
import { type CosignatureState, transitionCosignature } from "../cosignature/index";
import {
  type GateSectionSelection,
  assertGatePassed,
  runAddendumComplianceGate,
  runEncounterComplianceGate,
} from "../gate/index";
import { type Layer2EnhanceOutcome, resolveLayer2Eligibility } from "../layer2";
import { type AddendumState, transitionAddendum } from "../lifecycle/addendum";
import { requiresCosignature, transitionEncounter } from "../lifecycle/encounter";
import { EncounterStateError } from "../lifecycle/errors";
import {
  checkEncounterDisciplinePair,
  checkMutableForEdit,
  checkParentNotVoided,
  checkServiceDateNotFuture,
  checkVersion,
  checkVocabVersion,
} from "../lifecycle/validation";

/**
 * GAP-029 / §4.6 — the service-level no-self-cosign guard, shared by the in-memory and Drizzle services so
 * a caller that bypasses the route (a worker, a future route) cannot cosign what it authored. Both sides
 * are MEMBERSHIP ids.
 */
export function assertNotAuthor(authorMembershipId: string, actorMembershipId: string): void {
  if (authorMembershipId === actorMembershipId) {
    throw new ForbiddenError("the author of an encounter cannot cosign it (no self-cosign)");
  }
}

/** The real caller signing an encounter/cosignature/addendum (§3.3/D13) — the acting membership +
 *  session id the CoP 418.104(c) provenance row (`encounter_signature`) is written under. Never the
 *  encounter's author; the caller may be a different clinician entirely (e.g. an RN cosigner). */
export interface SigningActor {
  readonly membershipId: string;
  readonly sessionId: string;
  /**
   * The M2 USER id of the signer (a different id space from the membership id). Only the chart-promotion path needs it
   * (it becomes `decidedByUserId` on `m8.chart_promotion.decided`); a promoted addendum refuses to sign without it.
   */
  readonly userId?: string;
}

/** The §4.6 owner facts the `m8.cosigner_role_match` predicate resolves for one encounter (RLS-backstopped). */
export interface EncounterAbacFacts {
  readonly encounterId: string;
  readonly patientId: string;
  readonly discipline: EncounterDiscipline;
  /** The membership/user that authored the draft — the no-self-cosign comparison (§4.6). */
  readonly authoredByUserId: string;
}

/** Loads an encounter's org-scoped owner facts (in-memory in the slice; Drizzle in prod under RLS). */
export interface EncounterAbacResolver {
  loadEncounter(organizationId: string, encounterId: string): Promise<EncounterAbacFacts | null>;
  /** The membership that authored one addendum of `encounterId` (`null` when absent/cross-tenant). */
  loadAddendumAuthor(
    organizationId: string,
    encounterId: string,
    addendumId: string,
  ): Promise<string | null>;
}

// ── route DTOs (in-memory; the Drizzle adapter projects rows to the SAME shapes) ────────────────────

export interface CreateEncounterArgs {
  readonly patientId: string;
  readonly admissionId: string;
  readonly visitId?: string;
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  readonly serviceDate: LocalDate;
  readonly faceToFaceEncounterId?: string;
  readonly bereavementPlanId?: string;
}

export interface EncounterListFilters {
  readonly patientId?: string;
  /** GAP-182 — caseload narrowing: when present, ONLY these patients' encounters may be returned (an empty
   *  list returns none). Absent = org-wide (the caller holds an org-wide scope role). */
  readonly patientIds?: readonly string[];
  readonly admissionId?: string;
  readonly status?: EncounterStatus;
  readonly authorId?: string;
  readonly lateEntryTier?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
}

export interface CreatedEncounter {
  readonly id: string;
  readonly status: "draft";
  readonly templateKey: string;
  readonly templateVersion: string;
  readonly version: number;
}

/** Route result for a vitals capture/edit — the derived facts that decorate `m8.vitals.captured` (§4.4). */
export interface VitalsResult {
  readonly vitalsId: string;
  readonly fieldsCaptured: readonly string[];
  readonly abnormalFlags: readonly string[];
  readonly bmi: string | null;
}

/**
 * One stored vitals set, read back (§2.2, §3.3 `vitals`). The write path returns only the DERIVED
 * facts (`VitalsResult`: ids + flags + BMI) and the measured values were then unreadable through any
 * caller-facing route — a clinician could record a blood pressure and never see it again (#92).
 *
 * `abnormalFlags` is re-derived on read with `deriveAbnormalFlags`, the same pure function the write
 * path uses, so the two cannot disagree about which value is out of range. It deliberately does NOT
 * call `planVitalsCapture`: that validates, and a stored row is a signed clinical record — a read
 * that can throw because a plausibility envelope was tightened after the write would make the record
 * unretrievable, which is the opposite of what 42 CFR 418.104 requires.
 *
 * `loincReferences` is not surfaced: it is per-field FHIR mapping metadata, not a clinician-facing
 * measurement, and M28 maps it from the table directly.
 */
export interface VitalsView {
  readonly id: string;
  readonly encounterId: string;
  readonly capturedAt: string;
  readonly bpSystolic: number | null;
  readonly bpDiastolic: number | null;
  readonly heartRate: number | null;
  readonly respiratoryRate: number | null;
  readonly temperature: string | null;
  readonly temperatureUnit: string | null;
  readonly spo2: number | null;
  readonly painScore: number | null;
  readonly painScale: string | null;
  readonly weight: string | null;
  readonly weightUnit: string | null;
  readonly height: string | null;
  readonly heightUnit: string | null;
  readonly bmi: string | null;
  readonly bloodGlucose: number | null;
  readonly bloodGlucoseUnit: string | null;
  readonly clinicallyNotIndicatedFields: readonly string[] | null;
  readonly clinicallyNotIndicatedReason: string | null;
  readonly abnormalFlags: readonly string[];
}

/** Route result for a mileage capture/edit — the authoritative figure (D10). */
export interface MileageResult {
  readonly mileageId: string;
  readonly milesDriven: string;
  readonly source: string;
}

/** The mileage row as recorded (F-063 — `POST`/`PATCH .../mileage` had no reader). */
export interface MileageView {
  readonly mileageId: string;
  readonly encounterId: string;
  readonly odometerStart: number | null;
  readonly odometerEnd: number | null;
  readonly milesDriven: string;
  readonly source: string;
  readonly manualOverrideReason: string | null;
  readonly routeProposedMiles: string | null;
  readonly recordedAt: string;
}

/**
 * One selectable vocabulary entry as the AUTHORING MENU offers it (F-063).
 *
 * `@wardenx/narrative-vocab`'s own header calls `entriesFor(encounterType, discipline)` "the entries a
 * menu surfaces … so the selection UI and the template engine see the same deterministic ordering" —
 * and no route ever surfaced it, so there was no selection UI to see anything. `PATCH .../selections`
 * takes `sectionId` and `code` as free strings at the boundary and the server rejects an unknown one,
 * which means an authoring client without this menu could only guess.
 *
 * `slots` is the phrase's `${…}` placeholders MINUS the ones the server fills from the assembly context
 * (`patient`, `serviceDate`) — i.e. exactly the keys the client must supply as `params`. Derived here
 * rather than published as a static list so a corpus edit cannot leave the client asking for a slot the
 * phrase no longer has.
 */
export interface VocabMenuEntry {
  readonly code: string;
  readonly label: string;
  readonly category: string;
  readonly bodySystem: string | null;
  readonly slots: readonly string[];
}

/** One template section with the entries a clinician may pick into it. */
export interface TemplateSectionView {
  readonly sectionId: string;
  readonly heading: string;
  /** A `required` section must carry ≥1 selection before the §2.6 Layer-3 gate lets the note finalize. */
  readonly required: boolean;
  readonly allowedCategories: readonly string[];
  readonly entries: readonly VocabMenuEntry[];
}

/**
 * The authoring menu for one encounter: its resolved HearthNote template, section by section, each with
 * the vocabulary entries eligible for this (encounterType × discipline) pair.
 *
 * Served from the server rather than shipped to the browser as a package, deliberately: `resolveTemplate`
 * + `entriesFor` + the `allowedCategories` scoping ARE the resolution rules `assembleSelections` enforces
 * on the way back in, and a second copy in the client is a second copy free to disagree with them.
 */
export interface EncounterTemplateView {
  readonly encounterId: string;
  readonly templateKey: string;
  readonly vocabVersion: string;
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  readonly sections: readonly TemplateSectionView[];
}

export interface EncounterView {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly visitId: string | null;
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  readonly serviceDate: LocalDate;
  readonly status: EncounterStatus;
  readonly lateEntryTier: string;
  readonly version: number;
  readonly authoredByUserId: string;
  readonly isF2f: boolean;
  readonly signedAt: string | null;
  readonly cosignedAt: string | null;
  readonly selections?: Record<string, unknown> | null;
  readonly finalDocumentation?: string | null;
  readonly vitals?: Record<string, unknown> | null;
  readonly mileage?: Record<string, unknown> | null;
  readonly carePlanLinks?: readonly CarePlanLinkResult[];
  /** The encounter's addenda, oldest first (single-read only; §4.1 route 2 — GAP-027). */
  readonly addenda?: readonly AddendumSummary[];
}

/**
 * One addendum as the encounter workspace view projects it. `authoredByUserId` is the AUTHOR's membership
 * (GAP-028) — shown read-only by the UI; the UI never sends an author identity back.
 */
export interface AddendumSummary {
  readonly id: string;
  readonly status: AddendumState;
  readonly reason: string;
  readonly authoredByUserId: string;
  readonly createdAt: string;
  readonly signedAt: string | null;
  readonly version: number;
}

/** One live care-plan link as the encounter workspace view projects it (`GET /encounters/:id`). */
export interface CarePlanLinkResult {
  readonly linkId: string;
  readonly problemId: string | null;
  readonly goalId: string | null;
  readonly interventionId: string | null;
}

// ── HearthNote selections (§2.6, #114) ──────────────────────────────────────────────────────────────

/** One selected vocabulary entry with its resolved `${slot}` params (the wire shape of `EntrySelection`). */
export interface SelectionEntryInput {
  readonly code: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** One section's selections plus the clinician's verbatim prose for it. */
export interface SelectionSectionInput {
  readonly sectionId: string;
  readonly entries: readonly SelectionEntryInput[];
  readonly freeText?: string;
}

/**
 * What a selections PATCH carries. SECTIONS ONLY — `templateKey` / `vocabVersion` / the pair are derived
 * server-side from the encounter row, so a caller cannot assemble a note against a template its
 * encounter's discipline may not use.
 */
export interface SelectionsInput {
  readonly sections: readonly SelectionSectionInput[];
}

/** The stored tree read back, with the Layer-1 assembly of it (routes 3b / 23b). */
export interface SelectionsView {
  readonly templateKey: string;
  readonly vocabVersion: string;
  readonly sections: readonly SelectionSectionInput[];
  readonly layer1Preview: string;
  readonly version: number;
}

/**
 * The `${patient}` slot Layer-1 interpolates.
 *
 * `AssemblyContext.patient` is documented as "the real name" at Layer 1, and M8 cannot resolve one: it
 * consumes no M5 reader (manifest `dependsOn: [1, 6, 7, 36, 38]`), and adding a cross-module dependency
 * to fill a narrative slot is a bigger decision than this fix. `Patient` is the safe resolution rather
 * than a placeholder — the assembled prose reads as ordinary clinical documentation ("Patient is
 * cardiovascularly stable…"), and it is PHI-minimal by construction. Named here so the day M8 does
 * consume a patient reader, there is exactly one line to change.
 */
export const ASSEMBLY_PATIENT_SLOT = "Patient";

/** Build the `SelectionState` the pure assembler takes from the stored tree + the encounter's own facts. */
/**
 * The §2.6 gate's view of a selection tree: presence only (how many entries, and whether the clinician
 * attached prose) — never the content. The Drizzle service derives the same shape from the STORED tree,
 * where the prose lives inside the DEK envelope and only a `hasFreeText` marker sits beside the codes.
 */
export function toGateSections(sections: readonly SelectionSectionInput[]): GateSectionSelection[] {
  return sections.map((s) => ({
    sectionId: s.sectionId,
    entryCount: s.entries.length,
    hasFreeText: (s.freeText?.length ?? 0) > 0,
  }));
}

export function toSelectionState(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
  sections: readonly SelectionSectionInput[],
  vocabVersion: string = VOCAB_VERSION,
): SelectionState {
  return {
    templateKey: hearthnoteTemplateKey(encounterType, discipline),
    vocabVersion,
    encounterType,
    discipline,
    sections: sections.map((s) => ({
      sectionId: s.sectionId,
      entries: s.entries.map((e) => ({ code: e.code, ...(e.params ? { params: e.params } : {}) })),
      ...(s.freeText === undefined ? {} : { freeText: s.freeText }),
    })),
  };
}

/**
 * The §2.7 code each `HearthnoteAssemblyError` maps to. The package documents this mapping in its own
 * `AssemblyErrorCode` union ("mapped to HTTP by the M8 service in T09"); it was never written, because
 * nothing ever called `assemble`. `TEMPLATE_KEY_MISMATCH` cannot occur through these routes — the key is
 * server-derived from the encounter row — but it is mapped rather than left to fall through as a 500.
 */
const ASSEMBLY_ERROR_CODE = {
  TEMPLATE_NOT_FOUND: "INVALID_ENCOUNTER_DISCIPLINE_PAIR",
  TEMPLATE_KEY_MISMATCH: "INVALID_ENCOUNTER_DISCIPLINE_PAIR",
  VOCAB_VERSION_MISMATCH: "VOCAB_VERSION_MISMATCH",
  UNKNOWN_VOCAB_CODE: "UNKNOWN_VOCAB_CODE",
} as const;

/**
 * Assemble the Layer-1 narrative for a selection tree, refusing anything that cannot become a note.
 *
 * Two failures are checked, and neither is allowed to pass silently:
 *
 *   · An unknown SECTION id. `assembleLayer1` walks the TEMPLATE's sections and looks each one up in the
 *     selection, so a section the template does not have is simply never visited — the content would be
 *     stored and then vanish from every render, which is the same class of silent loss as the discarded
 *     PATCH itself. Rejected here instead.
 *   · An unknown vocabulary CODE, an illegal (encounterType × discipline) pair, or a vocab-version
 *     mismatch — `assemble`'s own guards, surfaced as the §2.7 codes above rather than a 500.
 *
 * Nothing is caught and turned into `""`. A note that cannot be assembled must say so; returning an
 * empty string for it is the defect this whole path is being fixed for.
 */
/**
 * Build the authoring menu for one (encounterType × discipline) pair — the pure half of `getTemplate`.
 *
 * The two resolution rules live HERE, beside `assembleSelections`, because they are the same rules read
 * in the other direction: `resolveTemplate` decides which sections exist (and `assembleSelections`
 * refuses a `sectionId` outside them), and `entriesFor` decides which vocabulary entries this pair may
 * use (and `assemble` refuses a code outside the corpus). A section's `allowedCategories` narrows the
 * menu further; a section that declares none accepts any entry the pair is eligible for.
 *
 * Slots are derived from each phrase rather than declared, minus the two the assembly context supplies
 * (`patient`, `serviceDate`) — so the client is asked for exactly the `params` keys interpolation needs,
 * and a corpus edit cannot leave it asking for one the phrase no longer has.
 */
export function buildTemplateMenu(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
): Omit<EncounterTemplateView, "encounterId"> {
  const template = resolveTemplate(encounterType, discipline);
  if (template === undefined) {
    throw new EncounterStateError(
      "INVALID_ENCOUNTER_DISCIPLINE_PAIR",
      `no HearthNote template for '${hearthnoteTemplateKey(encounterType, discipline)}'`,
    );
  }
  const eligible = entriesFor(encounterType, discipline);
  return {
    templateKey: template.key,
    vocabVersion: VOCAB_VERSION,
    encounterType,
    discipline,
    sections: template.sections.map((section) => {
      const allowed = section.allowedCategories;
      return {
        sectionId: section.id,
        heading: section.heading,
        required: section.required,
        allowedCategories: allowed === undefined ? [] : [...allowed],
        entries: eligible
          .filter((e) => allowed === undefined || allowed.includes(e.category))
          .map((e) => ({
            code: e.code,
            label: e.label,
            category: e.category,
            bodySystem: e.bodySystem ?? null,
            slots: phraseSlots(e.phrase),
          })),
      };
    }),
  };
}

/** The `${…}` placeholders a phrase interpolates, minus the two the assembly context always supplies. */
function phraseSlots(phrase: string): string[] {
  const found = new Set<string>();
  for (const m of phrase.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)) {
    const slot = m[1] as string;
    if (slot !== "patient" && slot !== "serviceDate") found.add(slot);
  }
  return [...found];
}

export function assembleSelections(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
  serviceDate: string,
  sections: readonly SelectionSectionInput[],
  vocabVersion: string = VOCAB_VERSION,
): string {
  const template = resolveTemplate(encounterType, discipline);
  if (template === undefined) {
    throw new EncounterStateError(
      "INVALID_ENCOUNTER_DISCIPLINE_PAIR",
      `no HearthNote template for '${hearthnoteTemplateKey(encounterType, discipline)}'`,
    );
  }
  const known = new Set(template.sections.map((t) => t.id));
  for (const s of sections) {
    if (!known.has(s.sectionId)) {
      throw new EncounterStateError(
        "UNKNOWN_TEMPLATE_SECTION",
        `section '${s.sectionId}' is not part of template '${template.key}'`,
      );
    }
  }
  const context: AssemblyContext = { patient: ASSEMBLY_PATIENT_SLOT, serviceDate };
  try {
    return assemble(toSelectionState(encounterType, discipline, sections, vocabVersion), context)
      .narrative;
  } catch (e) {
    if (e instanceof HearthnoteAssemblyError) {
      throw new EncounterStateError(ASSEMBLY_ERROR_CODE[e.code], e.message);
    }
    throw e;
  }
}

/** The route service the §4.1 handlers compose over. Every method is org-scoped (RLS in prod). */
/**
 * The M7 element refs a care-plan link records (F-064 / #159).
 *
 * The route parsed exactly this shape and then discarded it — `addCarePlanLink(organizationId,
 * encounterId)` took no third argument — so the link that says *this visit addressed this problem /
 * worked this goal / delivered this intervention* was never written for any encounter the platform has
 * recorded. The 201 it answered carried the ENCOUNTER's own id under the name `linkId`.
 *
 * At least one ref is required. That is the table's `at_least_one` CHECK, enforced here as well so the
 * caller gets a 422 naming the field rather than a raw `23514`.
 */
export interface CarePlanLinkInput {
  readonly problemId?: string;
  readonly goalId?: string;
  readonly interventionId?: string;
}

/** One live care-plan link on an encounter. */
export interface CarePlanLinkView {
  readonly id: string;
  readonly encounterId: string;
  readonly problemId: string | null;
  readonly goalId: string | null;
  readonly interventionId: string | null;
  readonly createdAt: string;
}

export interface EncounterRouteService {
  createDraft(
    organizationId: string,
    actorUserId: string,
    args: CreateEncounterArgs,
  ): Promise<CreatedEncounter>;
  getEncounter(organizationId: string, encounterId: string): Promise<EncounterView>;
  updateSelections(
    organizationId: string,
    encounterId: string,
    ifVersion: number,
    input: SelectionsInput,
  ): Promise<{ version: number; layer1Preview: string }>;
  /** Read the stored selection tree back, assembled (#114 — the round-trip the PATCH never had). */
  getSelections(organizationId: string, encounterId: string): Promise<SelectionsView>;
  captureVitals(
    organizationId: string,
    encounterId: string,
    input: VitalsInput,
  ): Promise<VitalsResult>;
  editVitals(
    organizationId: string,
    encounterId: string,
    vitalsId: string,
    input: VitalsInput,
  ): Promise<VitalsResult>;
  /**
   * The authoring menu — the resolved template + the vocabulary each section accepts (F-063).
   *
   * Without it there is no note composer that is not an invention: `PATCH .../selections` carries
   * `sectionId`/`code` as free strings and the server rejects an unknown one, so a client with no menu
   * can only guess at both. The template registry and the vocabulary have existed as pure leaf packages
   * since M8-T05; nothing ever put them on the wire.
   */
  getTemplate(organizationId: string, encounterId: string): Promise<EncounterTemplateView>;
  /** Read back the encounter's mileage row (F-063 — `POST`/`PATCH .../mileage` had no reader). */
  getMileage(organizationId: string, encounterId: string): Promise<MileageView | null>;
  /** Read back every vitals set recorded on one encounter, newest capture first (#92). */
  listVitals(
    organizationId: string,
    encounterId: string,
  ): Promise<{ encounterId: string; vitals: VitalsView[] }>;
  captureMileage(
    organizationId: string,
    encounterId: string,
    input: MileageInput,
  ): Promise<MileageResult>;
  editMileage(
    organizationId: string,
    encounterId: string,
    input: MileageInput,
  ): Promise<MileageResult>;
  addCarePlanLink(
    organizationId: string,
    actorMembershipId: string,
    encounterId: string,
    input: CarePlanLinkInput,
  ): Promise<CarePlanLinkView>;
  removeCarePlanLink(
    organizationId: string,
    actorMembershipId: string,
    encounterId: string,
    linkId: string,
  ): Promise<void>;
  listCarePlanLinks(
    organizationId: string,
    encounterId: string,
  ): Promise<{ links: readonly CarePlanLinkView[] }>;
  documentEvvMissing(
    organizationId: string,
    encounterId: string,
    reason: string,
  ): Promise<{ evvBracketState: string }>;
  finalize(
    organizationId: string,
    encounterId: string,
    at: LocalDate,
    args?: { lateEntryReason?: string },
  ): Promise<{ status: "finalized"; version: number }>;
  /** §2.6 D5 — invoke Layer-2. Returns the ladder's verdict; see {@link Layer2EnhanceOutcome} for why
   *  there is no `enhanced: true` arm to return yet (#123). */
  enhanceHearthnote(organizationId: string, encounterId: string): Promise<Layer2EnhanceOutcome>;
  recordModificationDecision(
    organizationId: string,
    encounterId: string,
    modId: string,
  ): Promise<{ modificationId: string }>;
  sign(
    organizationId: string,
    encounterId: string,
    actor: SigningActor,
    args: { at: LocalDate; lateEntryReason?: string },
  ): Promise<{
    status: "signed" | "cosign_pending";
    signedAt: string;
    cosignatureRequestId: string | null;
  }>;
  lateEntryOverride(
    organizationId: string,
    encounterId: string,
    args: { actorMembershipId: string; reason: string },
  ): Promise<{ status: EncounterStatus }>;
  administrativeOverride(
    organizationId: string,
    encounterId: string,
    args: { actorMembershipId: string; reason: string },
  ): Promise<{ status: EncounterStatus }>;
  voidEncounter(
    organizationId: string,
    encounterId: string,
    args: { isAdmin: boolean; reason: string; at: LocalDate },
  ): Promise<{ status: "voided" }>;
  getCosignature(
    organizationId: string,
    encounterId: string,
  ): Promise<{ status: CosignatureState | null }>;
  /** `actor` is the CALLER: it may never be the encounter's author (GAP-029 — ForbiddenError). */
  cosignAcknowledge(
    organizationId: string,
    encounterId: string,
    actor: SigningActor,
    at: LocalDate,
  ): Promise<{ status: CosignatureState }>;
  cosignSign(
    organizationId: string,
    encounterId: string,
    actor: SigningActor,
    args: { isQualifiedRn: boolean; at: LocalDate },
  ): Promise<{ status: EncounterStatus; cosignedAt: string }>;
  supervisorRelease(
    organizationId: string,
    encounterId: string,
    args: { isSupervisor: boolean; reason: string; at: LocalDate },
  ): Promise<{ status: CosignatureState }>;
  createAddendum(
    organizationId: string,
    encounterId: string,
    /** `authorMembershipId` is the CALLER — the addendum's author, never the parent encounter's. */
    args: {
      reason: string;
      authorMembershipId: string;
      /** WP 3.7: author this addendum from a proposed secure message (the reviewer still writes their own text). */
      promotion?: AddendumPromotionInput;
    },
  ): Promise<{ id: string; status: "draft" }>;
  /** WP 3.7: the proposals waiting on a reviewer for this encounter's patient (`enabled:false` when the hub flag is off). */
  listChartPromotions(
    organizationId: string,
    encounterId: string,
    reviewerUserId: string,
  ): Promise<ChartPromotionListView>;
  /** WP 3.7: decline a proposal. Writes nothing in M8 except the `m8.chart_promotion.decided` outbox event. */
  rejectChartPromotion(
    organizationId: string,
    encounterId: string,
    requestId: string,
    args: { reviewerUserId: string; reasonCode: RejectReasonCode },
  ): Promise<{ promotionRequestId: string; outcome: "rejected" }>;
  updateAddendumSelections(
    organizationId: string,
    encounterId: string,
    addendumId: string,
    input: SelectionsInput,
  ): Promise<{ version: number; layer1Preview: string }>;
  getAddendumSelections(
    organizationId: string,
    encounterId: string,
    addendumId: string,
  ): Promise<SelectionsView>;
  finalizeAddendum(
    organizationId: string,
    encounterId: string,
    addendumId: string,
  ): Promise<{ status: "finalized" }>;
  signAddendum(
    organizationId: string,
    encounterId: string,
    addendumId: string,
    actor: SigningActor,
    args: { at: LocalDate },
  ): Promise<{ status: "signed"; signedAt: string }>;
  listEncounters(
    organizationId: string,
    filters?: EncounterListFilters,
  ): Promise<{ encounters: EncounterView[] }>;
  cosignatureQueue(organizationId: string): Promise<{ encounters: EncounterView[] }>;
  myDrafts(organizationId: string, actorUserId: string): Promise<{ encounters: EncounterView[] }>;
  billable(
    organizationId: string,
    encounterIds: readonly string[],
  ): Promise<{ billability: { encounterId: string; billable: boolean }[] }>;
  signedSince(organizationId: string, since: string): Promise<{ encounters: EncounterView[] }>;
  /** The M22/M28 render payload. `pinned` says whether `final` is the byte-for-byte narrative recorded at
   *  finalize (`hearthnote_assembled_output.final_cipher`) or a live re-assembly of the current selection
   *  tree — a legal record versus a preview of one, which a renderer must be able to tell apart (#122). */
  renderPayload(
    organizationId: string,
    encounterId: string,
  ): Promise<{ encounterId: string; final: string; pinned: boolean }>;
}

// ── in-memory record + slice ────────────────────────────────────────────────────────────────────────

interface EncounterRecord {
  id: string;
  organizationId: string;
  /** F-064 — the live + removed care-plan links (the slice's stand-in for `encounter_care_plan_link`). */
  carePlanLinks?: Array<{
    id: string;
    problemId: string | null;
    goalId: string | null;
    interventionId: string | null;
    createdAt: string;
    removedAt: string | null;
  }>;
  patientId: string;
  admissionId: string;
  visitId: string | null;
  encounterType: EncounterType;
  discipline: EncounterDiscipline;
  serviceDate: LocalDate;
  status: EncounterStatus;
  lateEntryTier: string;
  version: number;
  authoredByUserId: string;
  isF2f: boolean;
  faceToFaceEncounterId: string | null;
  signedAt: string | null;
  cosignedAt: string | null;
  cosignature: CosignatureState | null;
  addenda: Map<
    string,
    {
      id: string;
      status: AddendumState;
      version: number;
      reason: string;
      createdAt: string;
      signedAt: string | null;
      selections: readonly SelectionSectionInput[];
      /** The membership that authored this addendum (the caller who created it). */
      authoredByUserId: string;
      /** WP 3.7: the proposal this addendum was authored from (null for a plain addendum). */
      promotionRequestId?: string;
      /** The narrative pinned at this addendum's finalize (#122). */
      pinnedNarrative?: string;
    }
  >;
  /** The stored HearthNote tree (#114). Empty until the clinician PATCHes selections. */
  selections: readonly SelectionSectionInput[];
  /** The narrative pinned at finalize (#122) — undefined while the encounter is still a draft. */
  pinnedNarrative?: string;
  /**
   * The corpus release the stored selections were AUTHORED against — the slice's stand-in for
   * `hearthnote_selection.template_version`, restamped on every selections PATCH exactly as the Drizzle
   * upsert restamps that column. Undefined until the clinician saves a tree (#128).
   */
  selectionsVocabVersion?: string;
  /** The D11 vocabulary pin written at finalize (#128) — a real corpus-release uuid, never a sentinel. */
  vocabVersionId?: string;
  /** The membership the D3 cosignature routed to, once one has (#124); null before sign / when none. */
  cosignerMembershipId?: string | null;
  vitals: Map<string, { capturedAt: string; bmi: string | null; input: VitalsInput }>;
  mileage: { id: string; milesDriven: string; source: string } | null;
}

/**
 * Project one stored vitals set into its read view (#92). Exported so the Drizzle adapter reuses the
 * exact same projection and ordering as the in-memory slice — the read DTO is a published contract,
 * and two hand-written projections of it would eventually disagree about a null.
 */
export function toVitalsView(
  id: string,
  encounterId: string,
  stored: { capturedAt: string; bmi: string | null; input: VitalsInput },
): VitalsView {
  const { input } = stored;
  return {
    id,
    encounterId,
    capturedAt: stored.capturedAt,
    bpSystolic: input.bpSystolic ?? null,
    bpDiastolic: input.bpDiastolic ?? null,
    heartRate: input.heartRate ?? null,
    respiratoryRate: input.respiratoryRate ?? null,
    temperature: input.temperature ?? null,
    temperatureUnit: input.temperatureUnit ?? null,
    spo2: input.spo2 ?? null,
    painScore: input.painScore ?? null,
    painScale: input.painScale ?? null,
    weight: input.weight ?? null,
    weightUnit: input.weightUnit ?? null,
    height: input.height ?? null,
    heightUnit: input.heightUnit ?? null,
    bmi: stored.bmi,
    bloodGlucose: input.bloodGlucose ?? null,
    bloodGlucoseUnit: input.bloodGlucoseUnit ?? null,
    clinicallyNotIndicatedFields: input.clinicallyNotIndicatedFields
      ? [...input.clinicallyNotIndicatedFields]
      : null,
    clinicallyNotIndicatedReason: input.clinicallyNotIndicatedReason ?? null,
    abnormalFlags: deriveAbnormalFlags(input),
  };
}

/** Newest capture first, id as the tiebreak so two sets captured in the same instant still order. */
export function byCapturedAtDesc(a: VitalsView, b: VitalsView): number {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/** The membership a cosignature routes to when the slice is not told otherwise (see below). */
export const SLICE_DEFAULT_COSIGNER_MEMBERSHIP_ID = "c0000000-0000-4000-8000-00000000c051";

/** Deterministic, I/O-free seed for the in-memory route service (slice + smoke tests). */
export interface EncounterRouteSeed {
  readonly encounters?: ReadonlyArray<
    Partial<EncounterRecord> & { id: string; organizationId: string; patientId: string }
  >;
  /**
   * §2.4 D3 / §2.6 check 10 — the patient's RN case manager as a membership id, or `null` for "this
   * patient has none". In production this comes from M5's `CareTeamProvider.primaryRnMembershipId`; this
   * slice binds no seams, so it is an injected function with a documented stand-in default
   * ({@link SLICE_DEFAULT_COSIGNER_MEMBERSHIP_ID}) — the same convention as `stepUpFresh` being `true`
   * here. It is a FUNCTION rather than a constant so a test can model "no eligible cosigner" without
   * the slice pretending to know the answer for every patient.
   */
  readonly primaryRnMembershipId?: (organizationId: string, patientId: string) => string | null;
}

/** Pads `n` to a uuid-shaped id so created ids round-trip through uuid-validated bodies (M6/M8 slice). */
function uuidFromCounter(prefixNibble: string, n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `${prefixNibble}0000000-0000-4000-8000-${hex}`;
}

const toView = (r: EncounterRecord): EncounterView => ({
  id: r.id,
  organizationId: r.organizationId,
  patientId: r.patientId,
  admissionId: r.admissionId,
  visitId: r.visitId,
  encounterType: r.encounterType,
  discipline: r.discipline,
  serviceDate: r.serviceDate,
  status: r.status,
  lateEntryTier: r.lateEntryTier,
  version: r.version,
  authoredByUserId: r.authoredByUserId,
  isF2f: r.isF2f,
  signedAt: r.signedAt,
  cosignedAt: r.cosignedAt,
  // Mirrors the Drizzle projection: the stored tree's codes only — prose is read via GET .../selections.
  selections:
    r.selections.length > 0
      ? { sections: r.selections.map((s) => ({ sectionId: s.sectionId, entries: s.entries })) }
      : null,
  finalDocumentation: r.pinnedNarrative ?? null,
  vitals: null,
  mileage: null,
  carePlanLinks: (r.carePlanLinks ?? [])
    .filter((l) => l.removedAt === null)
    .map((l) => ({
      linkId: l.id,
      problemId: l.problemId,
      goalId: l.goalId,
      interventionId: l.interventionId,
    })),
});

/**
 * Build an in-memory {@link EncounterRouteService} + a matching {@link EncounterAbacResolver} over one
 * shared dataset — no DB, deterministic, RLS-free (the slice scopes every read by the passed `organizationId`
 * so a cross-tenant id is a non-leaking 404, mirroring how RLS would behave in prod).
 */
/** Read-only inspection surface over the slice's state (the §7 workflow tests assert against it). */
export interface EncounterBackendInspect {
  /** The `m8.*` outbox events published so far (collected from the §2.8 transition/authoring effects). */
  events(): ReadonlyArray<{
    event: string;
    encounterId: string;
    payload?: Record<string, unknown>;
  }>;
  /** The M6 attestation writes the F2F dual-write requested (the cross-module side of D1, §7.4). */
  f2fAttestations(): ReadonlyArray<F2fAttestationWrite>;
  /** The resolved mileage row on an encounter, if any (D10). */
  mileageOf(encounterId: string): { id: string; milesDriven: string; source: string } | null;
  /** The number of vitals rows captured on an encounter (§2.2 — 0..n per visit). */
  vitalsCount(encounterId: string): number;
  /** The membership the D3 cosignature routed to, or null (§2.4 — the assigned RN case manager, #124). */
  cosignerOf(encounterId: string): string | null;
  /** The D11 corpus-release uuid pinned at finalize, or null while still a draft (#128). */
  vocabPinOf(encounterId: string): string | null;
}

export function createInMemoryEncounterBackend(seed: EncounterRouteSeed = {}): {
  service: EncounterRouteService;
  resolver: EncounterAbacResolver;
  inspect: EncounterBackendInspect;
} {
  const byId = new Map<string, EncounterRecord>();
  for (const e of seed.encounters ?? []) {
    byId.set(e.id, {
      admissionId: "00000000-0000-4000-8000-000000000000",
      visitId: null,
      encounterType: "routine_visit",
      discipline: "rn",
      serviceDate: "2026-01-01",
      status: "draft",
      lateEntryTier: "normal",
      version: 0,
      authoredByUserId: "seed",
      isF2f: false,
      faceToFaceEncounterId: null,
      signedAt: null,
      cosignedAt: null,
      cosignature: null,
      addenda: new Map(),
      selections: [],
      vitals: new Map(),
      mileage: null,
      ...e,
    });
  }
  const primaryRnMembershipId =
    seed.primaryRnMembershipId ?? (() => SLICE_DEFAULT_COSIGNER_MEMBERSHIP_ID);
  let created = 0;
  let subCounter = 0;
  const now = () => "2026-06-21T12:00:00.000Z";

  /** Published `m8.*` outbox events (collected from the §2.8 transition/authoring effects, for tests). */
  const events: { event: string; encounterId: string; payload?: Record<string, unknown> }[] = [];
  /** The M6 attestation writes the F2F dual-write requested (the cross-module side of D1, for tests). */
  const f2fAttestations: F2fAttestationWrite[] = [];
  const recordOutbox = (
    encounterId: string,
    effects: ReadonlyArray<{ kind: string; event?: string }>,
  ): void => {
    for (const e of effects)
      if (e.kind === "outbox" && e.event) events.push({ event: e.event, encounterId });
  };

  /** Load an encounter scoped to the tenant; a missing/cross-tenant id is a non-leaking 404. */
  function load(organizationId: string, encounterId: string): EncounterRecord {
    const r = byId.get(encounterId);
    if (!r || r.organizationId !== organizationId) throw new NotFoundError("encounter");
    return r;
  }

  const subId = () => uuidFromCounter("1", ++subCounter);
  /**
   * §2.6 Layer-3 gate (#121) — the same pure function the Drizzle service runs, over this slice's
   * records. `carePlanOverdue: null` is this slice's convention, not a verdict: it binds no seams (the
   * M7 reader reads under the caller's ambient request context and this dataset has none), the same
   * reason `stepUpFresh` is `true` here and resolved for real in the Drizzle backend. So the slice
   * decides the checks it CAN — every required template section populated — and defers the ones it
   * cannot to the production path, where the verdict is real. Checks 2/3 (#125) join that list: this
   * slice tracks no `vitals` rows and binds no M9 seam, so it reports every roster entry already
   * satisfied (the template's OWN required roster, not an empty one — an empty one would silently
   * WIDEN what this slice's callers can sign relative to production for any type that requires vitals).
   */
  const gate = (r: EncounterRecord, at: "finalize" | "sign"): boolean => {
    const template = resolveTemplate(r.encounterType, r.discipline);
    const verdict = runEncounterComplianceGate({
      encounterType: r.encounterType,
      discipline: r.discipline,
      sections: toGateSections(r.selections),
      carePlanOverdue: null,
      vitalsCaptured: new Set(template ? requiredVitalsFor(template) : []),
      vitalsClinicallyNotIndicated: new Set(),
      scalesPresent: new Set(requiredScalesFor(r.encounterType)),
    });
    assertGatePassed(verdict, at);
    return verdict.pass;
  };

  const gateAddendum = (
    sections: readonly SelectionSectionInput[],
    at: "finalize" | "sign",
  ): boolean => {
    const verdict = runAddendumComplianceGate(toGateSections(sections));
    assertGatePassed(verdict, at);
    return verdict.pass;
  };

  const service: EncounterRouteService = {
    async createDraft(organizationId, actorUserId, args) {
      // §2.7 service guards that run before any write (the rest land with authoring in M8-T10).
      checkEncounterDisciplinePair({
        encounterType: args.encounterType,
        discipline: args.discipline,
      });
      checkServiceDateNotFuture({ serviceDate: args.serviceDate, today: now().slice(0, 10) });
      const id = uuidFromCounter("e", ++created);
      byId.set(id, {
        id,
        organizationId,
        patientId: args.patientId,
        admissionId: args.admissionId,
        visitId: args.visitId ?? null,
        encounterType: args.encounterType,
        discipline: args.discipline,
        serviceDate: args.serviceDate,
        status: "draft",
        lateEntryTier: "normal",
        version: 0,
        authoredByUserId: actorUserId,
        isF2f: args.encounterType === "face_to_face" || args.faceToFaceEncounterId !== undefined,
        faceToFaceEncounterId: args.faceToFaceEncounterId ?? null,
        signedAt: null,
        cosignedAt: null,
        cosignature: null,
        addenda: new Map(),
        selections: [],
        vitals: new Map(),
        mileage: null,
      });
      return {
        id,
        status: "draft",
        // The registry key, not an invented one. This used to be `${discipline}_${encounterType}_v1`,
        // a string matching no template in `@wardenx/hearthnote`'s registry — so a client that used it
        // to fetch its section list would have found nothing (#114).
        templateKey: hearthnoteTemplateKey(args.encounterType, args.discipline),
        templateVersion: VOCAB_VERSION,
        version: 0,
      };
    },

    async getEncounter(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      return {
        ...toView(r),
        addenda: [...r.addenda.values()].map((a) => ({
          id: a.id,
          status: a.status,
          reason: a.reason,
          authoredByUserId: a.authoredByUserId,
          createdAt: a.createdAt,
          signedAt: a.signedAt,
          version: a.version,
        })),
      };
    },

    async updateSelections(organizationId, encounterId, ifVersion, input) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      checkVersion({ expected: ifVersion, actual: r.version });
      // Assemble BEFORE persisting: an unknown vocabulary code or an illegal pair must reject the write,
      // not be stored and discovered later by whoever tries to render the note.
      const layer1Preview = assembleSelections(
        r.encounterType,
        r.discipline,
        r.serviceDate,
        input.sections,
      );
      r.selections = input.sections;
      r.selectionsVocabVersion = VOCAB_VERSION;
      r.version += 1;
      return { version: r.version, layer1Preview };
    },

    async getTemplate(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      return { encounterId, ...buildTemplateMenu(r.encounterType, r.discipline) };
    },

    async getMileage(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      if (!r.mileage) return null;
      return {
        mileageId: r.mileage.id,
        encounterId,
        odometerStart: null,
        odometerEnd: null,
        milesDriven: r.mileage.milesDriven,
        source: r.mileage.source,
        manualOverrideReason: null,
        routeProposedMiles: null,
        recordedAt: r.serviceDate,
      };
    },

    async getSelections(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      return {
        templateKey: hearthnoteTemplateKey(r.encounterType, r.discipline),
        vocabVersion: VOCAB_VERSION,
        sections: r.selections,
        layer1Preview: assembleSelections(
          r.encounterType,
          r.discipline,
          r.serviceDate,
          r.selections,
        ),
        version: r.version,
      };
    },

    async captureVitals(organizationId, encounterId, input) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      const plan = planVitalsCapture(input); // validates envelopes + CNI reason (§2.2)
      const vitalsId = subId();
      r.vitals.set(vitalsId, { capturedAt: now(), bmi: plan.bmi, input });
      recordOutbox(r.id, plan.effects);
      return {
        vitalsId,
        fieldsCaptured: plan.fieldsCaptured,
        abnormalFlags: plan.abnormalFlags,
        bmi: plan.bmi,
      };
    },
    async editVitals(organizationId, encounterId, vitalsId, input) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      const prior = r.vitals.get(vitalsId);
      if (!prior) throw new NotFoundError("vitals");
      const plan = planVitalsCapture(input);
      r.vitals.set(vitalsId, { capturedAt: prior.capturedAt, bmi: plan.bmi, input });
      recordOutbox(r.id, plan.effects);
      return {
        vitalsId,
        fieldsCaptured: plan.fieldsCaptured,
        abnormalFlags: plan.abnormalFlags,
        bmi: plan.bmi,
      };
    },
    async listVitals(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      return {
        encounterId: r.id,
        vitals: [...r.vitals.entries()]
          .map(([id, v]) => toVitalsView(id, r.id, v))
          .sort(byCapturedAtDesc),
      };
    },
    async captureMileage(organizationId, encounterId, input) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      const plan = planMileageCapture(input); // validates odometer order + override reason (D10)
      const mileageId = r.mileage?.id ?? subId(); // D10 — 0..1 per encounter (unique on encounter_id)
      r.mileage = { id: mileageId, milesDriven: plan.milesDriven, source: plan.source };
      recordOutbox(r.id, plan.effects);
      return { mileageId, milesDriven: plan.milesDriven, source: plan.source };
    },
    async editMileage(organizationId, encounterId, input) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      const plan = planMileageCapture(input);
      const mileageId = r.mileage?.id ?? subId();
      r.mileage = { id: mileageId, milesDriven: plan.milesDriven, source: plan.source };
      recordOutbox(r.id, plan.effects);
      return { mileageId, milesDriven: plan.milesDriven, source: plan.source };
    },
    async addCarePlanLink(organizationId, actorMembershipId, encounterId, input) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      assertAtLeastOneCarePlanRef(input);
      // Idempotent: re-linking the same live (problem, goal, intervention) triple returns that link.
      const same = (r.carePlanLinks ?? []).find(
        (l) =>
          l.removedAt === null &&
          l.problemId === (input.problemId ?? null) &&
          l.goalId === (input.goalId ?? null) &&
          l.interventionId === (input.interventionId ?? null),
      );
      if (same) {
        return {
          id: same.id,
          encounterId: r.id,
          problemId: same.problemId,
          goalId: same.goalId,
          interventionId: same.interventionId,
          createdAt: same.createdAt,
        };
      }
      const link = {
        id: subId(),
        problemId: input.problemId ?? null,
        goalId: input.goalId ?? null,
        interventionId: input.interventionId ?? null,
        createdAt: now(),
        removedAt: null,
      };
      r.carePlanLinks = [...(r.carePlanLinks ?? []), link];
      return {
        id: link.id,
        encounterId: r.id,
        problemId: link.problemId,
        goalId: link.goalId,
        interventionId: link.interventionId,
        createdAt: link.createdAt,
      };
    },
    async removeCarePlanLink(organizationId, actorMembershipId, encounterId, linkId) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      const link = (r.carePlanLinks ?? []).find((l) => l.id === linkId && l.removedAt === null);
      // 404 rather than a silent 204: the route used to return 204 having removed nothing, and a
      // no-op that reports success is indistinguishable from a working delete.
      if (!link)
        throw new NotFoundError(`Care-plan link ${linkId} not found on encounter ${encounterId}`);
      link.removedAt = now();
    },
    async listCarePlanLinks(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      return {
        links: (r.carePlanLinks ?? [])
          .filter((l) => l.removedAt === null)
          .map((l) => ({
            id: l.id,
            encounterId: r.id,
            problemId: l.problemId,
            goalId: l.goalId,
            interventionId: l.interventionId,
            createdAt: l.createdAt,
          })),
      };
    },
    async documentEvvMissing(organizationId, encounterId, _reason) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      return { evvBracketState: "evv_missing_documented" };
    },

    async finalize(organizationId, encounterId, at) {
      const r = load(organizationId, encounterId);
      const t = transitionEncounter(r.status, {
        type: "finalize",
        gatePreviewPassed: gate(r, "finalize"),
        at,
      });
      // §2.7 D11 (#128) — the same guard the Drizzle service runs, over the same fact: a draft whose
      // selections were authored against an older corpus than this build ships cannot be finalized,
      // because the phrases it selected may no longer render identically. Kept in BOTH implementations
      // deliberately; a rule enforced in only one of them is a rule the slice's tests cannot pin.
      const pin = activeNarrativeVocabRelease(VOCAB_VERSION);
      if (r.selectionsVocabVersion !== undefined) {
        checkVocabVersion({
          pinnedVersionId: r.selectionsVocabVersion,
          activeVersionId: pin.version,
        });
      }
      r.status = t.to;
      r.version += 1;
      r.vocabVersionId ??= pin.id; // set at FIRST finalize, immutable thereafter (D11)
      // The `persist_assembled_output` effect (#122). The slice holds no DEK and no table, so the pin is
      // the assembled string on the record — but it is a PIN: nothing reassembles it afterwards, so a
      // later edit to the selection tree cannot change what this encounter says.
      r.pinnedNarrative = assembleSelections(
        r.encounterType,
        r.discipline,
        r.serviceDate,
        r.selections,
      );
      recordOutbox(r.id, t.effects);
      return { status: "finalized", version: r.version };
    },

    // §2.6 D5 (#123). Was a minted id and an echo — neither identified a `hearthnote_llm_modification`,
    // because nothing writes one. The slice models the same refusal the production service does.
    async enhanceHearthnote(organizationId, encounterId) {
      load(organizationId, encounterId);
      return { enhanced: false, reason: resolveLayer2Eligibility() };
    },
    async recordModificationDecision(organizationId, encounterId, modId) {
      load(organizationId, encounterId);
      // The slice holds no modification rows (nothing produces one), so every id names nothing.
      void modId;
      throw new NotFoundError("hearthnote_llm_modification");
    },

    async sign(organizationId, encounterId, actor, args) {
      const r = load(organizationId, encounterId);
      // GAP-028 — defence in depth behind the route's `is_author` guard: only the author signs.
      if (r.authoredByUserId !== actor.membershipId) {
        throw new ForbiddenError("only the author of an encounter may sign it");
      }
      // In-memory reference slice: no real session/step-up infra (not mounted in production — see the
      // module header), so step-up is always treated as fresh here. The production Drizzle backend
      // resolves this for real via M2's SessionContextResolver seam.
      const stepUpFresh = true;
      // §7.4 D1 — an F2F encounter signs as one atomic dual-write: the M8 clinical note + the M6
      // `face_to_face_encounter` attestation row. The plan produces the M6 write descriptor; the slice
      // records it here (the composition root hands it to M6's writer in prod). A failed gate / stale
      // step-up throws inside the plan → neither side is written (structural abort).
      if (r.isF2f) {
        const plan = planF2fDualWrite({
          status: r.status,
          encounterId: r.id,
          faceToFaceEncounterId: r.faceToFaceEncounterId,
          discipline: r.discipline,
          gatePassed: gate(r, "sign"),
          stepUpFresh,
          at: args.at,
        });
        r.status = plan.encounter.to;
        r.signedAt = now();
        f2fAttestations.push(plan.attestation);
        recordOutbox(r.id, plan.encounter.effects);
        return { status: "signed", signedAt: r.signedAt, cosignatureRequestId: null };
      }
      // §2.6 check 10 (#124) — the routed cosigner and the "an eligible cosigner exists" verdict are one
      // answer, exactly as in the Drizzle service. Excluding the signer is the same structural guard:
      // a note must never cosign itself.
      const cosigner = requiresCosignature(r.discipline)
        ? primaryRnMembershipId(organizationId, r.patientId)
        : null;
      const t = transitionEncounter(r.status, {
        type: "sign",
        discipline: r.discipline,
        gatePassed: gate(r, "sign"),
        stepUpFresh,
        isF2f: false,
        f2fDualWriteSatisfied: true,
        eligibleCosignerExists: cosigner !== null && cosigner !== actor.membershipId,
        at: args.at,
      });
      r.status = t.to;
      r.signedAt = now();
      recordOutbox(r.id, t.effects);
      if (t.to === "cosign_pending") {
        r.cosignature = "routed";
        r.cosignerMembershipId = cosigner;
        return { status: "cosign_pending", signedAt: r.signedAt, cosignatureRequestId: subId() };
      }
      return { status: "signed", signedAt: r.signedAt, cosignatureRequestId: null };
    },

    async lateEntryOverride(organizationId, encounterId, _args) {
      const r = load(organizationId, encounterId);
      r.lateEntryTier = "significant_late_entry";
      return { status: r.status };
    },
    async administrativeOverride(organizationId, encounterId, _args) {
      const r = load(organizationId, encounterId);
      r.lateEntryTier = "administrative_override";
      return { status: r.status };
    },

    async voidEncounter(organizationId, encounterId, args) {
      const r = load(organizationId, encounterId);
      const t = transitionEncounter(r.status, {
        type: "void",
        isAdmin: args.isAdmin,
        reason: args.reason,
        at: args.at,
      });
      r.status = t.to;
      recordOutbox(r.id, t.effects);
      return { status: "voided" };
    },

    async getCosignature(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      return { status: r.cosignature };
    },
    async cosignAcknowledge(organizationId, encounterId, actor, at) {
      const r = load(organizationId, encounterId);
      assertNotAuthor(r.authoredByUserId, actor.membershipId);
      const t = transitionCosignature(r.cosignature ?? "routed", { type: "acknowledge", at });
      r.cosignature = t.to;
      return { status: t.to };
    },
    async cosignSign(organizationId, encounterId, actor, args) {
      const r = load(organizationId, encounterId);
      assertNotAuthor(r.authoredByUserId, actor.membershipId);
      const ct = transitionCosignature(r.cosignature ?? "routed", {
        type: "sign",
        isQualifiedRn: args.isQualifiedRn,
        // In-memory reference slice: no real step-up infra (not mounted in production).
        stepUpFresh: true,
        at: args.at,
      });
      r.cosignature = ct.to;
      const et = transitionEncounter(r.status, { type: "recordCosignature", at: args.at });
      r.status = et.to;
      r.cosignedAt = now();
      recordOutbox(r.id, et.effects);
      return { status: r.status, cosignedAt: r.cosignedAt };
    },
    async supervisorRelease(organizationId, encounterId, args) {
      const r = load(organizationId, encounterId);
      const t = transitionCosignature(r.cosignature ?? "hard_cap_reached", {
        type: "release",
        isSupervisor: args.isSupervisor,
        reason: args.reason,
        at: args.at,
      });
      r.cosignature = t.to;
      return { status: t.to };
    },

    async createAddendum(organizationId, encounterId, args) {
      const r = load(organizationId, encounterId);
      checkParentNotVoided({ parentStatus: r.status });
      if (r.status !== "signed" && r.status !== "cosigned") {
        throw new EncounterStateError(
          "ILLEGAL_TRANSITION",
          "addenda can only be authored on signed or cosigned encounters",
        );
      }
      if (args.promotion) {
        await requireReview(
          organizationId,
          args.promotion.requestId,
          args.promotion.reviewerUserId,
          r.patientId,
        );
        const taken = [...r.addenda.values()].some(
          (x) => x.promotionRequestId === args.promotion?.requestId,
        );
        if (taken) throw new ConflictError("that proposal already has an addendum");
      }
      const id = subId();
      r.addenda.set(id, {
        ...(args.promotion ? { promotionRequestId: args.promotion.requestId } : {}),
        id,
        status: "draft",
        version: 0,
        reason: args.reason,
        createdAt: now(),
        signedAt: null,
        selections: [],
        authoredByUserId: args.authorMembershipId,
      });
      return { id, status: "draft" };
    },
    async updateAddendumSelections(organizationId, encounterId, addendumId, input) {
      const r = load(organizationId, encounterId);
      const a = r.addenda.get(addendumId);
      if (!a) throw new NotFoundError("addendum");
      const layer1Preview = assembleSelections(
        r.encounterType,
        r.discipline,
        r.serviceDate,
        input.sections,
      );
      a.selections = input.sections;
      a.version += 1;
      return { version: a.version, layer1Preview };
    },

    async getAddendumSelections(organizationId, encounterId, addendumId) {
      const r = load(organizationId, encounterId);
      const a = r.addenda.get(addendumId);
      if (!a) throw new NotFoundError("addendum");
      return {
        templateKey: hearthnoteTemplateKey(r.encounterType, r.discipline),
        vocabVersion: VOCAB_VERSION,
        sections: a.selections,
        layer1Preview: assembleSelections(
          r.encounterType,
          r.discipline,
          r.serviceDate,
          a.selections,
        ),
        version: a.version,
      };
    },
    async finalizeAddendum(organizationId, encounterId, addendumId) {
      const r = load(organizationId, encounterId);
      const a = r.addenda.get(addendumId);
      if (!a) throw new NotFoundError("addendum");
      const t = transitionAddendum(a.status, {
        type: "finalize",
        gatePreviewPassed: gateAddendum(a.selections, "finalize"),
        at: now().slice(0, 10),
      });
      a.status = t.to;
      a.pinnedNarrative = assembleSelections(
        r.encounterType,
        r.discipline,
        r.serviceDate,
        a.selections,
      );
      return { status: "finalized" };
    },
    async signAddendum(organizationId, encounterId, addendumId, actor, args) {
      const r = load(organizationId, encounterId);
      const a = r.addenda.get(addendumId);
      if (!a) throw new NotFoundError("addendum");
      const t = transitionAddendum(a.status, {
        type: "sign",
        gatePassed: gateAddendum(a.selections, "sign"),
        // In-memory reference slice: no real step-up infra (not mounted in production).
        stepUpFresh: true,
        at: args.at,
      });
      a.status = t.to;
      a.signedAt = now();
      if (a.promotionRequestId) {
        if (!actor.userId) throw new UnauthorizedError();
        events.push({
          event: CHART_PROMOTION_DECIDED_EVENT,
          encounterId,
          payload: decidedPayload({
            organizationId,
            promotionRequestId: a.promotionRequestId,
            outcome: "accepted",
            resultRef: addendumId,
            decidedByUserId: actor.userId,
            reasonCode: null,
            at: new Date(a.signedAt),
          }),
        });
      }
      return { status: "signed", signedAt: a.signedAt };
    },
    async listChartPromotions(organizationId, encounterId, reviewerUserId) {
      const r = load(organizationId, encounterId);
      return listForPatient(organizationId, r.patientId, reviewerUserId);
    },
    async rejectChartPromotion(organizationId, encounterId, requestId, args) {
      const r = load(organizationId, encounterId);
      await requireReview(organizationId, requestId, args.reviewerUserId, r.patientId);
      events.push({
        event: CHART_PROMOTION_DECIDED_EVENT,
        encounterId,
        payload: decidedPayload({
          organizationId,
          promotionRequestId: requestId,
          outcome: "rejected",
          resultRef: null,
          decidedByUserId: args.reviewerUserId,
          reasonCode: args.reasonCode,
          at: new Date(now()),
        }),
      });
      return { promotionRequestId: requestId, outcome: "rejected" };
    },

    async listEncounters(organizationId, filters = {}) {
      return {
        encounters: [...byId.values()]
          .filter((r) => r.organizationId === organizationId)
          .filter((r) => (filters.patientId ? r.patientId === filters.patientId : true))
          .filter((r) => (filters.patientIds ? filters.patientIds.includes(r.patientId) : true))
          .filter((r) => (filters.admissionId ? r.admissionId === filters.admissionId : true))
          .filter((r) => (filters.status ? r.status === filters.status : true))
          .filter((r) => (filters.authorId ? r.authoredByUserId === filters.authorId : true))
          .filter((r) => (filters.from ? r.serviceDate >= filters.from : true))
          .filter((r) => (filters.to ? r.serviceDate <= filters.to : true))
          .map(toView),
      };
    },
    async cosignatureQueue(organizationId) {
      return {
        encounters: [...byId.values()]
          .filter((r) => r.organizationId === organizationId && r.status === "cosign_pending")
          .map(toView),
      };
    },
    async myDrafts(organizationId, actorUserId) {
      return {
        encounters: [...byId.values()]
          .filter(
            (r) =>
              r.organizationId === organizationId &&
              r.status === "draft" &&
              r.authoredByUserId === actorUserId,
          )
          .map(toView),
      };
    },
    async billable(organizationId, encounterIds) {
      const wanted = new Set(encounterIds);
      return {
        billability: [...byId.values()]
          .filter((r) => r.organizationId === organizationId && wanted.has(r.id))
          .map((r) => ({
            encounterId: r.id,
            billable: r.status === "signed" || r.status === "cosigned",
          })),
      };
    },
    async signedSince(organizationId, since) {
      return {
        encounters: [...byId.values()]
          .filter(
            (r) =>
              r.organizationId === organizationId && r.signedAt !== null && r.signedAt >= since,
          )
          .map(toView),
      };
    },
    async renderPayload(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      // The pinned bytes win when they exist (#122) — a finalized note renders what it said, not what the
      // current selection tree would say now.
      if (r.pinnedNarrative !== undefined) {
        return { encounterId: r.id, final: r.pinnedNarrative, pinned: true };
      }
      // Was `final: ""` unconditionally. An empty string is a RENDERABLE answer, so a bound M22 renderer
      // would have produced an empty note and reported success; a 404 is the truthful answer when the
      // encounter has no HearthNote to render (#114).
      if (r.selections.length === 0) throw new NotFoundError("hearthnote_selection");
      return {
        encounterId: r.id,
        final: assembleSelections(r.encounterType, r.discipline, r.serviceDate, r.selections),
        pinned: false,
      };
    },
  };

  const resolver: EncounterAbacResolver = {
    async loadEncounter(organizationId, encounterId) {
      const r = byId.get(encounterId);
      if (!r || r.organizationId !== organizationId) return null;
      return {
        encounterId: r.id,
        patientId: r.patientId,
        discipline: r.discipline,
        authoredByUserId: r.authoredByUserId,
      };
    },
    async loadAddendumAuthor(organizationId, encounterId, addendumId) {
      const r = byId.get(encounterId);
      if (!r || r.organizationId !== organizationId) return null;
      return r.addenda.get(addendumId)?.authoredByUserId ?? null;
    },
  };

  const inspect: EncounterBackendInspect = {
    events: () => events,
    f2fAttestations: () => f2fAttestations,
    mileageOf: (encounterId) => byId.get(encounterId)?.mileage ?? null,
    vitalsCount: (encounterId) => byId.get(encounterId)?.vitals.size ?? 0,
    cosignerOf: (encounterId) => byId.get(encounterId)?.cosignerMembershipId ?? null,
    vocabPinOf: (encounterId) => byId.get(encounterId)?.vocabVersionId ?? null,
  };

  return { service, resolver, inspect };
}
