// apps/backend/src/modules/08-encounters — PRODUCTION EncounterRouteService (M8L-T01 reads, T02 writes).
//
// The screen-driving READS (encounter detail, the org encounter list, the cosignature queue, my open
// drafts, billability, signed-since, and the cosignature-request status) run as real Drizzle queries over
// the M8-owned tables inside `withOrgContext`, so RLS scopes every row by `app.org_id` as the unprivileged
// `chartwarden_app` role. The WRITE lifecycle is now real (M8L-T02): draft creation, vitals/mileage authoring,
// care-plan link, EVV-missing, finalize (pins the vocab version), the §2.3 sign machine (incl. the §7.4 D1
// F2F dual-write and the LPN/CHHA cosignature routing), the §2.4 D3 cosignature-request chain
// (acknowledge → sign / supervisor-release), the §2.5 D4 late-entry overrides, void, and the addendum
// aggregate (draft → finalize → sign). Every mutation drives the SAME pure machine the in-memory slice
// does, folds the declared §2.8 effects into the row UPDATE, and emits its `m8.*` event on the caller's
// transactional outbox — no route is left at 501.
//
// The EncounterRouteService interface threads no acting membership into every call, so (mirrors M7L-T02's
// null-actor convention): (1) writes envelope `withOrgContext` with `userId:""` so the M4 write-audit
// trigger fires with a NULL actor; (2) columns the route never captures — the assigned RN cosigner, a
// supervisor override reason — are filled from the authoring membership or a documented sentinel. GAP-204:
// the former compromise (3) is retired — every primary sign / cosignature / addendum-sign now writes an
// `encounter_signature` provenance row (see the §3.3/D13 block below) and the HearthNote selection /
// Layer-2 rows are persisted through the `hearthnote_selection` / `hearthnote_assembled_output` tables.
import { isStepUpRecent } from "@chartwarden/auth";
import { type DbClient, organizationTimezone, schema } from "@chartwarden/db";
import {
  DEFAULT_HEARTHNOTE_FLAGS,
  enhanceNarrative,
  templateKey as hearthnoteTemplateKey,
  requiredScalesFor,
} from "@chartwarden/hearthnote";
import { VOCAB_VERSION, activeNarrativeVocabRelease } from "@chartwarden/narrative-vocab";
import { localDateInTimeZone } from "@chartwarden/shared/dates";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type AdmissionSummary,
  type CarePlanOverdueStatus,
  type EncounterClockStartSource,
  type EncounterVisitModality,
  type EvvBracketResolution,
  ForbiddenError,
  type LocalDate,
  NotFoundError,
  type PatientId,
  STEP_UP_POLICY,
  type ScaleType,
  type StepUpFactor,
  UnauthorizedError,
  ValidationError,
} from "@chartwarden/types";
import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import {
  assertAtLeastOneCarePlanRef,
  planF2fDualWrite,
  planMileageCapture,
  planVitalsCapture,
} from "./authoring/index";
import {
  CHART_PROMOTION_DECIDED_EVENT,
  decidedPayload,
  listForPatient,
  mapPromotionInsertError,
  promotionHasDraft,
  requireReview,
} from "./chart-promotion";
import {
  clampClockStart,
  isValidServiceDate,
  localDayStart,
  stampClockIfNull,
} from "./closure/clock-stamp";
import { myNotesOf } from "./closure/my-notes";
import { OPEN_NOTE_STATUS_LIST_SQL } from "./closure/open-status";
import { readClosurePolicy } from "./closure/policy-service";
import { seedModalityFor } from "./consumers/seed-modality";
import {
  acknowledgeCosignature,
  readCosignatureStatus,
  releaseCosignature,
  signCosignature,
} from "./cosignature/db-cosignature";
import { COSIGN_OPEN_STATUSES, cosignDisplayStatus, cosignSubjectOf } from "./cosignature/index";
import { createAmendmentFlow } from "./drafting/amendment-flow";
import { namedSectionIds } from "./drafting/amendment-store";
import { defaultDraftPorts } from "./drafting/default-ports";
import { assertResolved, confirmedSectionIds } from "./drafting/note-draft";
import type { NoteDraft } from "./drafting/note-draft";
import { createNoteDraftFlow } from "./drafting/note-draft-flow";
import {
  type NoteHistory,
  type NoteOriginal,
  type StructuredNoteView,
  readNoteVersions,
} from "./drafting/note-versions";
import { readPinnedNote } from "./drafting/pinned-note";
import { isVisitNoteDraftEnabled } from "./drafting/policy-service";
import type { DraftSeamPorts, DraftViewer } from "./drafting/ports";
import { deriveEvvAtSign } from "./evv-at-sign";
import {
  type GateSectionSelection,
  assertGatePassed,
  deriveVitalsGateFacts,
  runAddendumComplianceGate,
  runEncounterComplianceGate,
} from "./gate/index";
import type { HearthnoteCiphers } from "./hearthnote-crypto";
import {
  decideAdministrativeLateOverride,
  decideSignificantLateOverride,
} from "./late-entry/override";
import { keepOrReplaceReason, reifiableTier, resolveLateEntry } from "./late-entry/resolve";
import { computeLateEntryTier, daysLate as lateDaysBetween } from "./late-entry/tiers";
import { LAYER2_TENANT_FACTS_UNBOUND, resolveLayer2Eligibility } from "./layer2";
import { ADDENDUM_GRAPH, type AddendumState, transitionAddendum } from "./lifecycle/addendum";
import {
  ENCOUNTER_GRAPH,
  type EncounterState,
  requiresCosignature,
  transitionEncounter,
} from "./lifecycle/encounter";
import { EncounterStateError } from "./lifecycle/errors";
import {
  checkEncounterDisciplinePair,
  checkMutableForEdit,
  checkParentNotVoided,
  checkServiceDateNotFuture,
  checkVersion,
  checkVocabVersion,
} from "./lifecycle/validation";
import { assertNotAuthor, toVitalsView } from "./routes/service";
import type {
  CarePlanLinkView,
  EncounterAbacFacts,
  EncounterAbacResolver,
  EncounterRouteService,
  EncounterView,
  SelectionSectionInput,
} from "./routes/service";
import { assembleSelections, buildTemplateMenu } from "./routes/service";
import {
  getCarePlanReader,
  getCareTeamProvider,
  getEvvBracketResolver,
  getLatestAssessmentProvider,
} from "./seams/index";
import { type StoredSelectionSection, openStoredProse, storedSections } from "./selection-tree";
import {
  assertModalityFitsVisitType,
  confirmedModalityColumns,
  deliveryViewFields,
  evvTimesAtSign,
  planDeliveryAtSign,
} from "./visit-delivery";

const ENC = schema.encounters;
const LINK = schema.encounterCarePlanLinks;
const COSIGN = schema.cosignatureRequests;
const ADDENDUM_COSIGN = schema.addendumCosignatureRequests;
const AMENDMENT = schema.encounterAmendments;
const ADDENDUM = schema.encounterAddenda;
const VITALS = schema.vitals;
const MILEAGE = schema.mileage;
const SIG = schema.encounterSignatures;
const SEL = schema.hearthnoteSelections;
const OUT = schema.hearthnoteAssembledOutputs;
const LLM = schema.hearthnoteLlmModifications;
const MEM = schema.memberships;

// ── The stored selection tree (#114 write path, #121 gate input) ──────────────────────────────────────
//
// The storage shape lives in ./selection-tree (shared with the visit-note draft's selection port): the two sides are converted at the
// storage boundary, in `splitFreeText` and `openProse`.

/** The §2.6 gate's view of a stored tree: presence only — how many entries, and whether prose exists. */
function gateSections(selections: unknown): GateSectionSelection[] {
  return storedSections(selections).map((s) => ({
    sectionId: s.sectionId,
    entryCount: s.entries?.length ?? 0,
    hasFreeText: s.hasFreeText === true,
  }));
}

// ── §3.3/D13 signature provenance (CoP 418.104(c), 21 CFR Part 11 principles) ─────────────────────────
//
// Every primary sign / cosignature / addendum-sign writes one `encounter_signature` row carrying WHO
// signed (the caller's real membership, not the encounter's author), WHAT method authenticated them,
// and WHEN their step-up was verified — sourced from M2's `SessionContextResolver` seam (the same
// source M3's `step_up_recent` predicate reads), never from a client-supplied timestamp. The route's
// `requireStepUp(...)` preHandler already denied the request if this resolves stale; resolving it again
// here (rather than threading a boolean through) mirrors the established "re-derive, don't trust a
// passed-through client claim" idiom (M11 Orders re-derives the cosigner role the same way).

/** `signature_method` has no `sms` value — STEP_UP_POLICY excludes sms from qualifying factors, so a
 *  fresh step-up can only ever be webauthn or totp by the time this runs (the route's requireStepUp
 *  gate already enforced that). `webauthn` covers both passkey and platform-biometric ceremonies; the
 *  session seam doesn't distinguish them, so passkey is the faithful default for the FIDO2 credential
 *  type (see catalog note in packages/audit for the analogous "don't invent a distinction the seam
 *  can't make" precedent). */
function stepUpFactorToSignatureMethod(
  factor: StepUpFactor,
): (typeof schema.signatureMethod.enumValues)[number] {
  switch (factor) {
    case "webauthn":
      return "passkey";
    case "totp":
      return "password_plus_otp";
    case "sms":
      throw new EncounterStateError(
        "STEP_UP_AUTH_REQUIRED",
        "sms does not qualify as a fresh step-up factor for a clinical signature",
      );
  }
}

/** The exact attestation language presented for each signature kind (§3.3 `attestation_text`, ≥ 50
 *  chars). Standard, fixed statements — not free-form user text — matching `layer2_involved_at_signing`
 *  always being `false` in this slice (no Layer-2/HearthNote provenance is captured yet; see
 *  `enhanceHearthnote`/`recordModificationDecision` above). Real product/legal copy TBD; these are the
 *  placeholder-but-real-shaped strings the file already uses this idiom for (see SIGNIFICANT_LATE_REASON
 *  et al. above). */
const PRIMARY_ATTESTATION_TEXT =
  "I attest that this clinical documentation is accurate and complete to the best of my knowledge, and that I am the practitioner responsible for the care described (primary signature, pending final legal copy).";
const ADDENDUM_ATTESTATION_TEXT =
  "I attest that this addendum is accurate and complete to the best of my knowledge (addendum signature, pending final legal copy).";

/** Resolved, server-verified signature provenance for one sign event. `stepUpFresh` is what the pure
 *  lifecycle machines gate on; `method`/`stepUpAuthAt` are only meaningful (and only read) when fresh. */
interface SignatureProvenance {
  readonly stepUpFresh: boolean;
  readonly method: (typeof schema.signatureMethod.enumValues)[number];
  readonly stepUpAuthAt: Date;
}

async function resolveSignatureProvenance(
  organizationId: string,
  sessionId: string,
): Promise<SignatureProvenance> {
  const state = await getSeam("SessionContextResolver").resolveStepUpState(
    { orgId: organizationId },
    sessionId,
  );
  if (
    !isStepUpRecent(state, STEP_UP_POLICY, Date.now()) ||
    !state?.lastStepUpAt ||
    !state.lastStepUpFactor
  ) {
    return { stepUpFresh: false, method: "passkey", stepUpAuthAt: new Date(0) };
  }
  return {
    stepUpFresh: true,
    method: stepUpFactorToSignatureMethod(state.lastStepUpFactor),
    stepUpAuthAt: state.lastStepUpAt,
  };
}

/**
 * The §2.7 D11 pinned vocabulary version (#128).
 *
 * This used to be a fixed sentinel uuid, written identically onto every encounter the platform ever
 * finalized, because `encounter.vocab_version_id` is a `uuid` and the corpus versions itself as a
 * string. It satisfied the `encounter_vocab_pinned_when_finalized` CHECK and identified nothing — so
 * §2.6 check 12 could not be evaluated against it in either direction (comparing a placeholder to a
 * real id refuses every signature; comparing it to itself passes unconditionally, which is the F-051
 * defect one level down).
 *
 * `@chartwarden/narrative-vocab` now carries the `(version → uuid)` registry the column always needed, and
 * this resolves the running build's release through it. The pin is the CORPUS release, not an M38
 * `code_system_version` row: architecture §10.5.2 makes Layer-1 assembly a pure function of
 * (selections × template × that package), M38 has no single active-version pointer to hold, and
 * `packages/narrative-vocab` is M8-owned so no seam is involved. See `releases.ts` for the full
 * reasoning — the module spec §2.7 names M38 and architecture wins on conflict.
 *
 * It THROWS on an unregistered version rather than degrading. That is deliberate: the alternative is
 * a placeholder that every later read is unable to tell from a real pin.
 */
function activeVocabPin(): { readonly id: string; readonly version: string } {
  return activeNarrativeVocabRelease(VOCAB_VERSION);
}

/**
 * The parent encounter's D11 pin, for an addendum assembled against it. Refuses rather than
 * substituting: a fabricated pin on an addendum would claim the addendum was written against a
 * vocabulary nobody chose, and the `encounter_vocab_pinned_when_finalized` CHECK already guarantees a
 * non-draft parent has one — so reaching the throw means the invariant is broken and inventing a value
 * would hide it.
 */
function requireParentVocabPin(pin: string | null, encounterId: string): string {
  if (pin === null) {
    throw new EncounterStateError(
      "VOCAB_VERSION_MISMATCH",
      `encounter ${encounterId} is finalized with no D11 vocabulary pin; an addendum cannot inherit one`,
    );
  }
  return pin;
}

/** §2.5 D4 override / §2.7 D9 EVV-missing reasons the thin route interface does not capture (sentinels
 * meeting the DB CHECK minimums; a real reason threads through when the route body carries it). */
/** The transactional-outbox port (§2.8): the bound publisher validates every emit against the boot
 * catalog and writes the `outbox_event` row on the CALLER'S tx. The default no-op lets the slice/tests
 * commit without a dispatcher (the row state is the load-bearing effect). Mirrors M7's port. */
export interface EncounterWriteOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}
const NOOP_OUTBOX: EncounterWriteOutboxPort = { async publish() {} };

/** F-064 — one live care-plan link, as the route projects it. */
const toCarePlanLinkView = (r: typeof LINK.$inferSelect): CarePlanLinkView => ({
  id: r.id,
  encounterId: r.encounterId,
  problemId: r.problemId,
  goalId: r.goalId,
  interventionId: r.interventionId,
  createdAt: r.createdAt.toISOString(),
});

/** First row of a RETURNING/SELECT, or a 500 (unreachable after a successful write). */
function firstOrThrow<T>(rows: readonly T[], msg: string): T {
  const r = rows[0];
  if (!r) throw new EncounterStateError("ILLEGAL_TRANSITION", msg);
  return r;
}

/** The row lock makes this unreachable today; the status guard on the UPDATE is what keeps a double sign a 409 if a path ever skips it. */
const SIGN_LOST_RACE = "sign matched no row: the encounter changed status since it was loaded";

/** The encounter columns every read projects (single source of truth for {@link toView}). */
const encounterCols = {
  id: ENC.id,
  organizationId: ENC.organizationId,
  patientId: ENC.patientId,
  admissionId: ENC.admissionId,
  visitId: ENC.visitId,
  encounterType: ENC.encounterType,
  discipline: ENC.discipline,
  serviceDate: ENC.serviceDate,
  status: ENC.status,
  lateEntryTier: ENC.lateEntryTier,
  version: ENC.version,
  authoredByMembershipId: ENC.authoredByMembershipId,
  faceToFaceEncounterId: ENC.faceToFaceEncounterId,
  signedAt: ENC.signedAt,
  cosignedAt: ENC.cosignedAt,
  visitModality: ENC.visitModality,
  visitModalityConfirmedAt: ENC.visitModalityConfirmedAt,
  timeSource: ENC.timeSource,
  evvBracketState: ENC.evvBracketState,
} as const;

type EncounterRow = {
  id: string;
  organizationId: string;
  patientId: string;
  admissionId: string;
  visitId: string | null;
  encounterType: EncounterView["encounterType"];
  discipline: EncounterView["discipline"];
  serviceDate: string;
  status: EncounterView["status"];
  lateEntryTier: string;
  version: number;
  authoredByMembershipId: string;
  faceToFaceEncounterId: string | null;
  signedAt: Date | string | null;
  cosignedAt: Date | string | null;
  visitModality: EncounterVisitModality | null;
  visitModalityConfirmedAt: Date | string | null;
  timeSource: string | null;
  evvBracketState: string | null;
};

/** Timestamptz → ISO string (drizzle returns a Date for `withTimezone` columns); mirror the in-memory shape. */
const iso = (v: Date | string | null): string | null =>
  v === null ? null : typeof v === "string" ? v : v.toISOString();

/** Project a real `encounter` row to the EXACT in-memory {@link EncounterView} shape. */
const toView = (r: EncounterRow): EncounterView => ({
  id: r.id,
  organizationId: r.organizationId,
  patientId: r.patientId,
  admissionId: r.admissionId,
  visitId: r.visitId,
  encounterType: r.encounterType,
  discipline: r.discipline,
  serviceDate: r.serviceDate as EncounterView["serviceDate"],
  status: r.status,
  lateEntryTier: r.lateEntryTier,
  version: Number(r.version),
  // The in-memory record keys the author by user id; the DB column is the authoring `membership` id.
  authoredByUserId: r.authoredByMembershipId,
  // Mirrors the in-memory `isF2f` derivation (§7.4 D1): the F2F encounter type OR a linked M6 F2F row.
  isF2f: r.encounterType === "face_to_face" || r.faceToFaceEncounterId !== null,
  signedAt: iso(r.signedAt),
  cosignedAt: iso(r.cosignedAt),
  ...deliveryViewFields(r),
});

function admissionServiceStart(summary: AdmissionSummary): LocalDate {
  return (summary.activatedAt ?? summary.admissionAt) as LocalDate;
}

function validateAdmissionForService(
  organizationId: string,
  patientId: string,
  serviceDate: LocalDate,
  summary: AdmissionSummary,
): void {
  if (summary.organizationId !== organizationId || summary.patientId !== patientId) {
    throw new NotFoundError("admission");
  }
  const startedAt = admissionServiceStart(summary);
  if (serviceDate < startedAt) {
    throw new ValidationError("encounter service date cannot precede admission activation", []);
  }
  if (summary.status === "active") return;
  if (
    (summary.status === "discharged" ||
      summary.status === "bereavement" ||
      summary.status === "closed") &&
    summary.dischargedAt !== null &&
    serviceDate <= summary.dischargedAt
  ) {
    return;
  }
  throw new ForbiddenError(
    `encounter authoring is not allowed while admission is '${summary.status}'`,
  );
}

async function admissionSummaryFor(
  organizationId: string,
  admissionId: string,
): Promise<AdmissionSummary> {
  return getSeam("AdmissionStatusReader").getAdmissionSummary(organizationId, admissionId);
}

/**
 * The production, RLS-backed EncounterRouteService. Reads and writes are real (Drizzle + RLS).
 * Org is bound from the request context by the caller and passed as `organizationId` — never the body.
 */
/** A caller with no identity of its own: its draft is redacted as for a member with no role and no Part 2 release (fails closed). */
const ANONYMOUS_VIEWER: DraftViewer = { roles: [], membershipId: null };

export function createDbEncounterRouteService(
  db: DbClient,
  outbox: EncounterWriteOutboxPort = NOOP_OUTBOX,
  ciphers?: HearthnoteCiphers,
  clock: () => Date = () => new Date(),
  /** ADR-0114: the seam-backed half of the visit-note draft the gate and sign read (M7, M9, M12, M39); the M1-registry wiring by default. */
  draftSeams: () => DraftSeamPorts = defaultDraftPorts,
): EncounterRouteService {
  /** GAP-013: the org-local calendar day (org timezone, never the request's UTC date) the late-entry tier is measured on. */
  const orgLocalToday = async (t: DbClient, organizationId: string): Promise<LocalDate> =>
    localDateInTimeZone(clock(), await organizationTimezone(t, organizationId)) as LocalDate;

  /**
   * ADR-0113: a seeded draft that never got an M17 start event gets its documentation clock on the AUTHOR's first
   * authoring write (and at sign, so a signed note always has one). Only the author's own write counts: the clock is the
   * author's duty, so an edit by anyone else (a supervisor on `IS_AUTHOR_OR_SUPERVISOR` routes) never starts it, and a
   * legacy (pre-deploy, clockless) draft is not clocked by someone else touching it (D9). A `null` `actorMembershipId`
   * (a caller with no acting member) stamps nothing. Write-once and open-notes-only in the UPDATE itself; the
   * row's own `clockStartedAt` just skips the round trip once it is set. A GET never calls this.
   */
  const stampDraftOpened = async (
    t: DbClient,
    organizationId: string,
    row: {
      readonly id: string;
      readonly clockStartedAt: Date | null;
      readonly authoredByMembershipId: string;
    },
    actorMembershipId: string | null,
  ): Promise<void> => {
    if (row.clockStartedAt !== null) return;
    if (actorMembershipId === null || actorMembershipId !== row.authoredByMembershipId) return;
    await stampClockIfNull(t, {
      orgId: organizationId,
      encounterId: row.id,
      at: clock(),
      source: "draft_opened",
    });
  };

  /**
   * ADR-0113 D1: what a note's clock does at CREATION. The clock starts at ARRIVAL, so a visit-linked note follows the visit, but a
   * `visitId` is otherwise just a uuid the clinician typed (no FK), so it counts only when the visit resolves, through the M17
   * `VisitReader` seam, in this organization AND is assigned to the author. Then: a visit that has not started yet leaves the clock to
   * the M17 `visit.started` event (`await_arrival`); one that has ALREADY started (that event came and went before this note existed)
   * starts the clock at the visit's actual start, with the source the event consumer would have used (`arrived`). Anything else (no
   * visit, a made-up or someone else's visit id, a seam that cannot answer) starts the clock at creation: the fail-safe is a clock that
   * runs, never one that waits, and an arbitrary visit id can neither defer the clock nor move it into the past.
   */
  type CreationClockPlan =
    | { readonly kind: "at_creation" }
    | { readonly kind: "await_arrival" }
    | {
        readonly kind: "arrived";
        readonly startedAt: Date;
        readonly source: EncounterClockStartSource;
        /** The VISIT's own service day (never the request's): the earliest the arrival may be held to. */
        readonly visitServiceDate: string;
      };

  async function creationClockPlan(
    organizationId: string,
    visitId: string | undefined,
    authorMembershipId: string,
  ): Promise<CreationClockPlan> {
    if (!visitId) return { kind: "at_creation" };
    try {
      const visit = await getSeam("VisitReader").visitForEncounter(organizationId, visitId);
      if (
        visit === null ||
        visit.organizationId !== organizationId ||
        visit.assignedMembershipId !== authorMembershipId
      ) {
        return { kind: "at_creation" };
      }
      if (visit.actualStartedAt === null) return { kind: "await_arrival" };
      const startedAt = new Date(visit.actualStartedAt);
      if (Number.isNaN(startedAt.getTime())) return { kind: "at_creation" };
      // The lower bound is the VISIT's service day: a request's own `serviceDate` is the clinician's to type, and using it would let
      // a late note claim today and start its clock days after the arrival. An unreadable date falls back to the creation instant.
      if (!isValidServiceDate(visit.serviceDate)) return { kind: "at_creation" };
      const source = visit.evvBracketState === "evv_present" ? "evv_check_in" : "visit_started";
      return { kind: "arrived", startedAt, source, visitServiceDate: visit.serviceDate };
    } catch {
      return { kind: "at_creation" };
    }
  }

  /**
   * The clock columns for the INSERT. An `arrived` instant is held between the VISIT's service day (in the organization's own
   * timezone) and now, so a skewed device instant on the visit cannot back-date or post-date it. The upper bound is the creation
   * instant because the visit row carries no "recorded at" instant (the M17 consumer, which has the event, caps at that instead).
   */
  async function creationClockColumns(
    t: DbClient,
    organizationId: string,
    plan: CreationClockPlan,
  ): Promise<{ clockStartedAt?: Date; clockStartSource?: EncounterClockStartSource }> {
    if (plan.kind === "await_arrival") return {};
    const created = clock();
    if (plan.kind === "at_creation")
      return { clockStartedAt: created, clockStartSource: "draft_created" };
    const timeZone = await organizationTimezone(t, organizationId);
    return {
      clockStartedAt: clampClockStart(
        plan.startedAt,
        localDayStart(plan.visitServiceDate, timeZone),
        created,
      ),
      clockStartSource: plan.source,
    };
  }

  const freeTextCipher = ciphers?.freeText;
  const narrativeCipher = ciphers?.narrative;

  /**
   * Run one tenant-DEK operation, turning a KEY-RESOLVE failure into the designed 503.
   *
   * Without this the `HEARTHNOTE_CIPHER_UNBOUND` code is unreachable in production: the composition root
   * always constructs the cipher OBJECTS (`createHearthnoteCiphers(getTenantKeyProvider())`), so the
   * `!cipher` branch only ever fires in the slice and in tests. The key resolve happens per CALL, deep
   * inside M34 — `dekForOrg` throws `M34InfraPortUnbound` while the KEK/KMS adapter is unbound (#105),
   * `TenantKeyMissing` for an org with no key ring, `TenantKeyDestroyed` after a crypto-shred. Unwrapped,
   * every one of those surfaces as a 500. They are all the same operational statement — this deployment
   * cannot key this tenant's PHI right now — and 503 is what says it.
   */
  async function withTenantDek<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      throw new EncounterStateError(
        "HEARTHNOTE_CIPHER_UNBOUND",
        `${what}: the tenant DEK could not be resolved (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
      );
    }
  }
  /**
   * ADR-0114: the visit-note draft's part in finalize and sign. A tenant with the switch off gets `null` from every read and the
   * gate, the pin and the sign are exactly what they were; with it on, the draft is read for the member acting (author at finalize,
   * signer at sign), the gate decides check 13 over it, and sign pins and seals the note's text in its own transaction.
   */
  const sealSignedSection = (organizationId: string, plaintext: string): Promise<string> => {
    if (!narrativeCipher) {
      throw new EncounterStateError(
        "HEARTHNOTE_CIPHER_UNBOUND",
        "no per-tenant DEK envelope is bound for M8, so the signed note's sections cannot be sealed",
      );
    }
    return withTenantDek("the signed note could not be sealed", () =>
      narrativeCipher.seal(organizationId, plaintext),
    );
  };
  const noteDraft = createNoteDraftFlow({
    clock,
    seams: draftSeams,
    ...(freeTextCipher ? { freeTextCipher } : {}),
    seal: sealSignedSection,
  });
  /**
   * ADR-0114 VN-D30: an addendum that NAMES sections of the signed note. The author resolves each one through the same draft pipeline (recomputed
   * for them as of the visit time) and sign seals the confirmed ones as amendment rows; an addendum that names nothing never touches it.
   */
  const amendments = createAmendmentFlow({
    clock,
    seams: draftSeams,
    ...(freeTextCipher ? { freeTextCipher } : {}),
    seal: sealSignedSection,
  });

  // ── HearthNote selections (§2.6/§3.6, #114) ────────────────────────────────────────────────────────
  //
  // `selections` (vocabulary codes + numeric slot params) goes to the jsonb column in the clear; the
  // clinician's verbatim prose goes to `free_text_cipher`, sealed under the tenant DEK. With NO cipher
  // bound, a tree carrying prose is REFUSED — the M32 R18 / M31 #117 posture: writing prose in the clear
  // into a column named `_cipher` would make the §3.6 minimization a claim rather than a fact. A tree
  // with no prose writes normally, so the structured note — which is what Layer-1 actually assembles —
  // never depends on a key ring that has not bound yet.
  const splitFreeText = (
    sections: readonly SelectionSectionInput[],
  ): { stored: StoredSelectionSection[]; prose: Record<string, string> } => {
    const stored: StoredSelectionSection[] = [];
    const prose: Record<string, string> = {};
    for (const s of sections) {
      const hasFreeText = s.freeText !== undefined && s.freeText.length > 0;
      // `hasFreeText` is storage METADATA, not content: the §2.6 gate counts a section populated when it
      // has entries OR prose, and the prose itself lives in the DEK envelope. Without this marker the
      // gate would have to open that envelope to answer a question about PRESENCE — reading PHI to
      // decide whether something is there, and refusing to run at all wherever the key ring is unbound.
      stored.push({
        sectionId: s.sectionId,
        entries: s.entries,
        ...(hasFreeText ? { hasFreeText } : {}),
      });
      if (hasFreeText) prose[s.sectionId] = s.freeText as string;
    }
    return { stored, prose };
  };

  async function sealProse(
    organizationId: string,
    prose: Record<string, string>,
  ): Promise<string | null> {
    if (Object.keys(prose).length === 0) return null;
    if (!freeTextCipher) {
      throw new EncounterStateError(
        "HEARTHNOTE_CIPHER_UNBOUND",
        "no per-tenant DEK envelope is bound for M8, so the clinician's free text cannot be sealed; a selection tree with no free text writes normally",
      );
    }
    return withTenantDek("the clinician's free text could not be sealed", () =>
      freeTextCipher.seal(organizationId, JSON.stringify(prose)),
    );
  }

  /** Re-attach the sealed prose to the stored tree. Never throws on a missing cipher — a reader without
   *  one still gets the structured note, and the absent `freeText` is the honest answer for it. */
  async function openProse(
    organizationId: string,
    row: { selections: unknown; freeTextCipher: string | null },
  ): Promise<SelectionSectionInput[]> {
    const cipher = freeTextCipher;
    return openStoredProse(
      row,
      cipher
        ? (envelope) =>
            withTenantDek("the clinician's free text could not be opened", () =>
              cipher.open(organizationId, envelope),
            )
        : undefined,
    );
  }

  // ── §2.6 Layer-3 compliance gate (#121) ───────────────────────────────────────────────────────────
  //
  // The gate itself is pure (./gate); this resolves the facts it decides over. Both write paths that
  // used to hand `transitionEncounter` the literal `true` now hand it this verdict.

  /**
   * M7's §7.8 overdue verdict (CoP 418.56). `null` = the patient has no active care plan, which the
   * gate treats as "no review window to have missed". A THROW is not that: M7's store runs under the
   * caller's ambient request context and refuses to read unscoped, and the boot deny-stub refuses
   * outright — either way the check did not run, and a signing-blocking control that passes when it
   * could not evaluate is precisely the defect this gate was fixed from. So it refuses, with a code
   * that says the gate was unavailable rather than that the note was incomplete.
   */
  async function carePlanOverdueFor(patientId: string): Promise<CarePlanOverdueStatus | null> {
    try {
      return await getCarePlanReader().isReviewOverdue(patientId as PatientId);
    } catch (cause) {
      throw new EncounterStateError(
        "COMPLIANCE_GATE_UNAVAILABLE",
        `the §2.6 care-plan review check could not be decided: M7's CarePlanReader is unreachable (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
      );
    }
  }

  /**
   * §2.6 check 3 (#125) — which of `requiredScalesFor(encounterType)`'s scales M9 already has an
   * active row for on this patient. Empty roster short-circuits without asking the seam at all, the
   * same posture as `requiredHopeItems` — no need to fail closed on a seam this encounter type never
   * consults. A seam failure is `COMPLIANCE_GATE_UNAVAILABLE`, same as the care-plan/cosigner checks:
   * a check that could not run must not read as passed.
   */
  async function scalesPresentFor(
    patientId: string,
    encounterType: (typeof ENC.$inferSelect)["encounterType"],
  ): Promise<Set<ScaleType>> {
    const required = requiredScalesFor(encounterType);
    if (required.length === 0) return new Set();
    try {
      const rows = await getLatestAssessmentProvider().latestBatch(
        patientId as PatientId,
        required,
      );
      return new Set(rows.map((row) => row.scaleType));
    } catch (cause) {
      throw new EncounterStateError(
        "COMPLIANCE_GATE_UNAVAILABLE",
        `the §2.6 required-scales check could not be decided: M9's LatestAssessmentProvider is unreachable (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
      );
    }
  }

  /**
   * Run the §2.6 gate for one encounter and raise the 422 + remediation list when it does not pass. `draft` is the acting member's
   * visit-note draft (ADR-0114), or `null` when the tenant has it switched off, in which case check 13 does not run.
   */
  async function gateEncounter(
    t: DbClient,
    r: typeof ENC.$inferSelect,
    at: "finalize" | "sign",
    draft: NoteDraft | null,
  ): Promise<boolean> {
    const [sel] = await t
      .select({ selections: SEL.selections })
      .from(SEL)
      .where(eq(SEL.encounterId, r.id))
      .limit(1);
    const vitalsRows = await t
      .select({
        bpSystolic: VITALS.bpSystolic,
        bpDiastolic: VITALS.bpDiastolic,
        heartRate: VITALS.heartRate,
        respiratoryRate: VITALS.respiratoryRate,
        temperature: VITALS.temperature,
        spo2: VITALS.spo2,
        painScore: VITALS.painScore,
        clinicallyNotIndicatedFields: VITALS.clinicallyNotIndicatedFields,
      })
      .from(VITALS)
      .where(eq(VITALS.encounterId, r.id));
    const { captured, clinicallyNotIndicated } = deriveVitalsGateFacts(vitalsRows);
    const verdict = runEncounterComplianceGate({
      encounterType: r.encounterType,
      discipline: r.discipline,
      sections: gateSections(sel?.selections ?? null),
      carePlanOverdue: await carePlanOverdueFor(r.patientId),
      vitalsCaptured: captured,
      vitalsClinicallyNotIndicated: clinicallyNotIndicated,
      scalesPresent: await scalesPresentFor(r.patientId, r.encounterType),
      ...(draft === null
        ? {}
        : {
            draftSectionActions: draft.actions,
            // Check 1 (project-lead decision): a section the clinician confirmed drafted text for is populated.
            draftConfirmedSectionIds: confirmedSectionIds(draft),
          }),
    });
    assertGatePassed(verdict, at);
    return verdict.pass;
  }

  /**
   * §2.4 D3 / §2.6 check 10 (#124) — the patient's RN case manager, as the membership a cosignature is
   * routed to. `null` means there is no eligible cosigner, which the §2.3 machine turns into
   * NO_ELIGIBLE_COSIGNER; the sign is refused BEFORE any write, so no signature row and no
   * `cosignature_request` routed at nobody are left behind.
   *
   * The spec is specific about who this is: "a `cosignature_request` row is created with the assigned RN
   * case manager as the routed cosigner" (§2.4). So the existence question and the routing question have
   * one answer, resolved once here — they used to have two different wrong ones, `true` and "the LPN who
   * just signed it".
   *
   * The signer is excluded explicitly. `patient_assignment.role = 'primary_rn'` already names an RN, and
   * the cosign route independently refuses a non-RN caller, so this should be unreachable — but a note
   * that cosigns itself is the one outcome the whole D3 workflow exists to prevent, and it costs a
   * comparison to make that structural rather than incidental.
   */
  async function cosignerMembershipIdFor(
    organizationId: string,
    patientId: string,
    signedByMembershipId: string,
  ): Promise<string | null> {
    let cosigner: string | null;
    try {
      cosigner = await getCareTeamProvider().primaryRnMembershipId({ organizationId, patientId });
    } catch (cause) {
      // Same posture as the care-plan check: a check that could not RUN must not read as one that
      // passed, and must not read as one that failed either — NO_ELIGIBLE_COSIGNER would tell a
      // clinician to go find an RN who may well be assigned.
      throw new EncounterStateError(
        "COMPLIANCE_GATE_UNAVAILABLE",
        `the §2.6 cosigner-exists check could not be decided: M5's CareTeamProvider is unreachable (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
      );
    }
    return cosigner === signedByMembershipId ? null : cosigner;
  }

  // ── §2.6 the assembled-output pin (#122) ────────────────────────────────────────────────────────
  //
  // `hearthnote_assembled_output` holds the bytes that ARE the signed narrative. Nothing had ever written
  // it: the §2.3 machine has emitted `{ kind: "persist_assembled_output" }` on every finalize since
  // M8-T04 — `encounter-lifecycle.test.ts` asserts that it does — and no service performed the effect. So
  // the note was reassembled from `hearthnote_selection` at every read, which defeats the D11 vocabulary
  // pin at the last step: a `@chartwarden/narrative-vocab` release that edits a phrase would change the
  // rendered text of an ALREADY-SIGNED encounter, and the `${patient}` slot (a literal today) will change
  // every historical note the day M8 binds an M5 reader. For a 42 CFR 418.104 legal record, "we can
  // rebuild it" is not the claim "here is what it said".

  /** Resolve one parent's stored tree. Absent → an empty section list, not a throw: a template with no
   *  REQUIRED section passes the §2.6 gate with nothing documented, and the honest pin for that is the
   *  template's own text. (An addendum cannot reach it — its gate refuses an empty tree outright.) */
  async function storedTreeFor(
    t: DbClient,
    organizationId: string,
    parent: { readonly encounterId: string } | { readonly addendumId: string },
  ): Promise<SelectionSectionInput[]> {
    const [row] = await t
      .select()
      .from(SEL)
      .where(
        "addendumId" in parent
          ? eq(SEL.addendumId, parent.addendumId)
          : eq(SEL.encounterId, parent.encounterId),
      )
      .limit(1);
    return row ? await openProse(organizationId, row) : [];
  }

  /**
   * Assemble the stored tree and PIN the result, sealed under the tenant DEK. Called once per finalize,
   * inside the finalize transaction, AFTER the §2.6 gate has passed — so a refused finalize leaves no row.
   *
   * The seal is not optional. `layer1_cipher` and `final_cipher` are NOT NULL and the column names are the
   * §3.6 promise; an assembled narrative is prose by construction, so unlike the selection tree there is no
   * codes-in-the-clear half that could be written without a key. A deployment that cannot key the tenant's
   * PHI therefore cannot finalize — see {@link withTenantDek} for why that surfaces as a 503 naming the
   * DEK, and #105 for the binding it names.
   */
  async function pinAssembledOutput(
    t: DbClient,
    organizationId: string,
    input: {
      readonly kind: "primary_finalize" | "addendum_finalize";
      readonly encounterId: string | null;
      readonly addendumId: string | null;
      readonly providerEntityId: string | null;
      readonly locationId: string | null;
      readonly encounterType: EncounterView["encounterType"];
      readonly discipline: EncounterView["discipline"];
      readonly serviceDate: string;
      readonly vocabVersionId: string;
      /** ADR-0114: the note's text when the visit-note draft is on (the confirmed draft and the clinician's own selections); absent, Layer 1 from the selections. */
      readonly narrative?: string;
      /** ADR-0114: that text carries a Part 2 derived section (`hearthnote_assembled_output.part2_derived`). */
      readonly part2Derived?: boolean;
    },
  ): Promise<void> {
    if (!narrativeCipher) {
      throw new EncounterStateError(
        "HEARTHNOTE_CIPHER_UNBOUND",
        "no per-tenant DEK envelope is bound for M8, so the assembled narrative cannot be sealed and the encounter cannot be finalized",
      );
    }
    const sections = await storedTreeFor(
      t,
      organizationId,
      input.addendumId === null
        ? { encounterId: input.encounterId as string }
        : { addendumId: input.addendumId },
    );
    const layer1 =
      input.narrative ??
      assembleSelections(input.encounterType, input.discipline, input.serviceDate, sections);
    // D5's finalize-time reification, through the module's own shipped ladder rather than a literal.
    // Phase 1: the platform flag is off, so this is `kill_switch_active` / `enhanced: false` / final === layer1.
    const outcome = enhanceNarrative({
      layer1,
      flags: DEFAULT_HEARTHNOTE_FLAGS,
      eligibility: LAYER2_TENANT_FACTS_UNBOUND,
    });
    const [layer1Cipher, finalCipher] = await withTenantDek(
      "the assembled narrative could not be sealed",
      () =>
        Promise.all([
          narrativeCipher.seal(organizationId, outcome.layer1),
          narrativeCipher.seal(organizationId, outcome.final),
        ]),
    );
    await t.insert(OUT).values({
      organizationId,
      providerEntityId: input.providerEntityId,
      locationId: input.locationId,
      encounterId: input.encounterId,
      addendumId: input.addendumId,
      kind: input.kind,
      layer1Cipher,
      finalCipher,
      // The layer2 pair is derived from the outcome, never asserted: the `hearthnote_output_layer2_consistency`
      // CHECK requires cipher-and-flag to agree, and deriving both from one value is what keeps them agreeing
      // when Layer 2 becomes reachable.
      layer2Cipher: null,
      layer2InvolvedAtFinalize: outcome.enhanced,
      layer2Eligibility: outcome.reason,
      part2Derived: input.part2Derived ?? false,
      assemblyTemplateKey: hearthnoteTemplateKey(input.encounterType, input.discipline),
      vocabVersionId: input.vocabVersionId,
    });
  }

  /** Run the §2.6 gate for one addendum (the narrower form — see runAddendumComplianceGate). */
  async function gateAddendum(
    t: DbClient,
    addendumId: string,
    at: "finalize" | "sign",
  ): Promise<boolean> {
    const [sel] = await t
      .select({ selections: SEL.selections })
      .from(SEL)
      .where(eq(SEL.addendumId, addendumId))
      .limit(1);
    const verdict = runAddendumComplianceGate(gateSections(sel?.selections ?? null));
    assertGatePassed(verdict, at);
    return verdict.pass;
  }
  /** Load one org-scoped encounter row → the shared projection, or `null` when absent/cross-tenant. */
  async function loadRow(
    organizationId: string,
    encounterId: string,
  ): Promise<EncounterRow | null> {
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const [r] = await tx.select(encounterCols).from(ENC).where(eq(ENC.id, encounterId)).limit(1);
      return (r as EncounterRow | undefined) ?? null;
    });
  }

  /** Emit one `m8.*` event on the caller's tx (validated + persisted by the bound publisher; no-op default). */
  async function emit(
    tx: unknown,
    org: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await outbox.publish(tx, {
      eventName,
      payload,
      organizationId: org,
      aggregateKind,
      aggregateId,
    });
  }

  /** What the cosignature workflow needs of this service: the transactional outbox and the server-verified signature provenance. */
  const cosignatureDeps = {
    emit: (
      tx: DbClient,
      org: string,
      eventName: string,
      aggregateKind: string,
      aggregateId: string,
      payload: Record<string, unknown>,
    ) => emit(tx, org, eventName, aggregateKind, aggregateId, payload),
    resolveProvenance: resolveSignatureProvenance,
  };

  /** GAP-177 — `m8.encounter.orphan_recorded`: a just-signed encounter with NO `visit_id` (ad-hoc /
   *  retroactive) is the M17 reconciliation fact (D2). Emitted beside `.signed`, on the same tx. */
  async function emitOrphanIfUnlinked(
    tx: unknown,
    org: string,
    r: { readonly id: string; readonly patientId: string; readonly visitId: string | null },
    signedAt: Date,
  ): Promise<void> {
    if (r.visitId) return;
    await emit(tx, org, "m8.encounter.orphan_recorded", "encounter", r.id, {
      encounterId: r.id,
      patientId: r.patientId,
      organizationId: org,
      recordedAt: signedAt.toISOString(),
    });
  }

  /** GAP-070 — the M18 bracket for the encounter's visit, or null (no visit / nothing bracketed / M18
   *  unreachable). Unreachable reads as "not resolved": EVV is never a sign gate (ADR-0008), and an
   *  unresolved bracket reports `evv_missing_documented`, so it can never count as EVV-verified.
   *  `askFailure` (non-null) says the null is "could not ask", not "nothing there": sign must not let a clinician's typed
   *  times stand in for a bracket M18 may hold (EVV always wins), so it refuses them while the lookup is down. The failure
   *  is kept (not swallowed) so the 503 sign answers with carries it as its `cause` into the server log. */
  async function resolveEvvBracketFor(
    organizationId: string,
    encounterId: string,
  ): Promise<{
    readonly resolution: EvvBracketResolution | null;
    readonly askFailure: { readonly cause: unknown } | null;
  }> {
    const row = await loadRow(organizationId, encounterId);
    if (!row?.visitId) return { resolution: null, askFailure: null };
    try {
      const resolution = await getEvvBracketResolver().resolveBracket({
        organizationId,
        visitId: row.visitId,
      });
      return { resolution, askFailure: null };
    } catch (cause) {
      return { resolution: null, askFailure: { cause } };
    }
  }

  /** Is an M18 EVV bracket on file for this encounter? A stored state is the answer; an unsigned row with no
   *  stored state asks M18 (the same resolution sign will use, so the ceremony and the write agree). */
  async function evvBracketPresentFor(
    organizationId: string,
    r: Pick<EncounterRow, "id" | "status" | "evvBracketState">,
  ): Promise<boolean> {
    if (r.evvBracketState !== null) return r.evvBracketState === "evv_present";
    if (r.status !== "draft" && r.status !== "finalized") return false;
    const { resolution } = await resolveEvvBracketFor(organizationId, r.id);
    return deriveEvvAtSign(null, resolution).state === "evv_present";
  }

  /** The delivery columns sign writes (visit-delivery.ts), resolved over the org clock and timezone. Throws the
   *  422s BEFORE any write, so a refused sign leaves nothing behind. */
  async function deliveryColumnsAtSign(
    t: DbClient,
    organizationId: string,
    r: typeof ENC.$inferSelect,
    args: Parameters<EncounterRouteService["sign"]>[3],
    evvAtSign: ReturnType<typeof deriveEvvAtSign>,
    evvAskFailure: { readonly cause: unknown } | null,
    signerMembershipId: string,
  ): Promise<Partial<typeof ENC.$inferInsert>> {
    // "EVV always wins" holds only if M18 was asked. With the lookup down and no stored EVV state, typed times could be
    // standing in for a bracket that exists (and that nothing reconciles later), so they are refused, retryably; signing
    // without times is unaffected.
    if (
      evvAskFailure !== null &&
      r.evvBracketState === null &&
      (args.startedAt !== undefined || args.endedAt !== undefined)
    ) {
      throw new EncounterStateError(
        "EVV_BRACKET_UNAVAILABLE",
        "the visit's check-in/check-out record could not be reached, so typed visit times cannot be accepted right now; try again in a moment, or sign without times",
        undefined,
        { cause: evvAskFailure.cause },
      );
    }
    const timeZone = await organizationTimezone(t, organizationId);
    const columns = planDeliveryAtSign(
      args,
      {
        discipline: r.discipline,
        encounterType: r.encounterType,
        serviceDate: r.serviceDate as LocalDate,
        visitModalityConfirmedAt: r.visitModalityConfirmedAt,
      },
      {
        signerMembershipId,
        now: clock(),
        localDateOf: (instant) => localDateInTimeZone(instant, timeZone) as LocalDate,
        evvTimes: evvTimesAtSign(r, evvAtSign),
      },
    );
    // A telephonic visit is never counted, so only an in-person / video bracket is held to the one-place-at-a-time rule.
    if (
      columns.timeSource === "clinician" &&
      columns.startedAt !== undefined &&
      columns.endedAt !== undefined &&
      (columns.visitModality ?? r.visitModality) !== "telephonic"
    ) {
      await assertNoOverlappingVisit(t, r, columns.startedAt, columns.endedAt);
    }
    return columns;
  }

  /** One person is in one place at a time: typed times may not overlap another in-person / video bracket the SAME author
   *  documented (signed visits on the service date or a day either side, since a visit may cross midnight). The other
   *  visit is not named: it may be another patient's. One author's typed signs are serialised on a transaction advisory lock
   *  (org + author), so two racing in the same instant cannot both pass the read: the second waits for the first to commit
   *  and then sees its row. Only TYPED times are checked: an EVV bracket is a device record and never a sign gate (ADR-0008),
   *  so one that overlaps a typed bracket signed EARLIER is not detected here, and claim validation does not compare brackets
   *  either (a known limit, recorded on CW-PI-05). */
  async function assertNoOverlappingVisit(
    t: DbClient,
    r: typeof ENC.$inferSelect,
    startedAt: Date,
    endedAt: Date,
  ): Promise<void> {
    await t.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`m8-visit-bracket:${r.organizationId}:${r.authoredByMembershipId}`}, 0))`,
    );
    const [clash] = await t
      .select({ id: ENC.id })
      .from(ENC)
      .where(
        and(
          ne(ENC.id, r.id),
          eq(ENC.authoredByMembershipId, r.authoredByMembershipId),
          inArray(ENC.status, ["signed", "cosign_pending", "cosigned"]),
          sql`${ENC.serviceDate} BETWEEN ${r.serviceDate}::date - 1 AND ${r.serviceDate}::date + 1`,
          isNotNull(ENC.startedAt),
          lt(ENC.startedAt, endedAt),
          gt(ENC.endedAt, startedAt),
          or(isNull(ENC.visitModality), ne(ENC.visitModality, "telephonic")),
        ),
      )
      .limit(1);
    if (clash) {
      throw new EncounterStateError(
        "VISIT_TIME_OVERLAP",
        "these visit times overlap another visit you documented; correct the times, or sign without times",
      );
    }
  }

  /** The encounter columns sign writes when it newly resolved an EVV bracket (empty otherwise). */
  function evvPersistence(
    evv: ReturnType<typeof deriveEvvAtSign>,
  ): Partial<typeof ENC.$inferInsert> {
    return evv.persist ?? {};
  }

  /**
   * Load a tenant-scoped encounter row FOR the write path (RLS-scoped) or raise the non-leaking 404.
   *
   * `lock` takes the row `FOR NO KEY UPDATE`: the one lock every request that decides something from the encounter's draft takes FIRST
   * (finalize, sign, the picker's link and unlink, the selections save and the draft's section PUT in `drafting/db-draft-unit.ts`), so
   * they run one after the other and each reads what the one before it committed. Without it a section PUT could commit between sign's
   * draft read and sign's UPDATE, and sign would seal sentences the PUT had just deselected; two signs would both read `finalized`.
   * `NO KEY UPDATE` rather than `UPDATE` so the foreign-key checks of the satellite inserts (vitals, mileage, signatures) still run.
   */
  async function loadEnc(
    t: DbClient,
    encounterId: string,
    opts: { readonly lock?: boolean } = {},
  ): Promise<typeof ENC.$inferSelect> {
    const query = t.select().from(ENC).where(eq(ENC.id, encounterId)).limit(1);
    const [row] = opts.lock ? await query.for("no key update") : await query;
    if (!row) throw new NotFoundError("encounter");
    return row;
  }

  /** After the row lock: an encounter another request has already moved on is a 409 here, not an error deep in the transition. */
  function assertLegalFrom(status: EncounterState, event: "finalize" | "sign"): void {
    if (!ENCOUNTER_GRAPH[status].includes(event)) {
      throw new EncounterStateError(
        "ILLEGAL_TRANSITION",
        `encounter cannot ${event} from '${status}'`,
      );
    }
  }

  /**
   * ADR-0114 VN-D30: the RN a signed AMENDMENT must be cosigned by, or `null` when its note never needed a cosigner (it has no cosignature request).
   * Refuses (422 NO_ELIGIBLE_COSIGNER, before any write) when the note needed one and there is none, or the signer is that RN, exactly as the note's
   * own sign does: an amendment nobody may cosign would leave the note's cosignature requirement unmet.
   */
  async function cosignerForAmendment(
    t: DbClient,
    organizationId: string,
    parent: typeof ENC.$inferSelect,
    signerMembershipId: string,
  ): Promise<string | null> {
    const [parentRequest] = await t
      .select({ id: COSIGN.id })
      .from(COSIGN)
      .where(eq(COSIGN.encounterId, parent.id))
      .limit(1);
    if (parentRequest === undefined) return null;
    const cosigner = await cosignerMembershipIdFor(
      organizationId,
      parent.patientId,
      signerMembershipId,
    );
    if (cosigner === null) {
      throw new EncounterStateError(
        "NO_ELIGIBLE_COSIGNER",
        "this note needed a cosignature, so its amendment does too, and no cosignature-eligible RN other than the signer exists on the patient's caseload",
      );
    }
    return cosigner;
  }

  /** The cosignature request an amending addendum opens, routed to the RN case manager with its own clock (`routed_at`); the note's own request is untouched. */
  async function openAddendumCosignature(
    t: DbClient,
    addendum: {
      readonly id: string;
      readonly organizationId: string;
      readonly encounterId: string;
      readonly providerEntityId: string;
      readonly locationId: string;
    },
    routedToMembershipId: string,
    routedAt: Date,
  ): Promise<string> {
    const created = firstOrThrow(
      await t
        .insert(ADDENDUM_COSIGN)
        .values({
          organizationId: addendum.organizationId,
          providerEntityId: addendum.providerEntityId,
          locationId: addendum.locationId,
          encounterId: addendum.encounterId,
          addendumId: addendum.id,
          routedToMembershipId,
          status: "routed",
          routedAt,
        })
        .returning({ id: ADDENDUM_COSIGN.id }),
      "addendum_cosignature_request insert returned no row",
    );
    // The same `cosignature_routed` the note's own request publishes (M36 alerts on it), now naming the addendum.
    await emit(
      t,
      addendum.organizationId,
      "m8.encounter.cosignature_routed",
      "addendum_cosignature_request",
      created.id,
      {
        encounterId: addendum.encounterId,
        addendumId: addendum.id,
        routedToMembershipId,
        signedAt: routedAt.toISOString(),
      },
    );
    return created.id;
  }

  /** Load an addendum scoped to its parent encounter or the non-leaking 404. */
  async function loadAddendum(
    t: DbClient,
    encounterId: string,
    addendumId: string,
  ): Promise<typeof ADDENDUM.$inferSelect> {
    const [row] = await t
      .select()
      .from(ADDENDUM)
      .where(and(eq(ADDENDUM.id, addendumId), eq(ADDENDUM.encounterId, encounterId)))
      .limit(1);
    if (!row) throw new NotFoundError("addendum");
    return row;
  }

  /** The encounter's patient (RLS-scoped; the non-leaking 404 when absent or cross-tenant). */
  async function patientOfEncounter(organizationId: string, encounterId: string): Promise<string> {
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const [row] = await (tx as unknown as DbClient)
        .select({ patientId: ENC.patientId })
        .from(ENC)
        .where(eq(ENC.id, encounterId))
        .limit(1);
      if (!row) throw new NotFoundError("encounter");
      return row.patientId;
    });
  }

  /** Create the addendum draft; when authored from a proposal, copy its attribution (the DB guard re-proves it on INSERT). */
  async function createAddendumTx(
    organizationId: string,
    encounterId: string,
    args: Parameters<EncounterRouteService["createAddendum"]>[2],
  ): Promise<{ id: string; status: "draft" }> {
    // The seam reads in its own tenant context, so resolve it BEFORE opening the write transaction.
    const review = args.promotion
      ? await requireReview(
          organizationId,
          args.promotion.requestId,
          args.promotion.reviewerUserId,
          await patientOfEncounter(organizationId, encounterId),
        )
      : null;
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const t = tx as unknown as DbClient;
      const r = await loadEnc(t, encounterId);
      checkParentNotVoided({ parentStatus: r.status });
      if (r.status !== "signed" && r.status !== "cosigned") {
        throw new EncounterStateError(
          "ILLEGAL_TRANSITION",
          "addenda can only be authored on signed or cosigned encounters",
        );
      }
      const a = firstOrThrow(
        await t
          .insert(ADDENDUM)
          .values({
            organizationId,
            encounterId,
            // GAP-028 - the CALLER authors the addendum, not the parent encounter's author.
            authoredByMembershipId: args.authorMembershipId,
            providerEntityId: r.providerEntityId,
            locationId: r.locationId,
            reason: args.reason,
            status: "draft",
            ...(review
              ? {
                  promotionRequestId: review.requestId,
                  sourceMessageId: review.sourceMessageId,
                  sourceAuthorUserId: review.sourceAuthorUserId,
                  sourceSentAt: new Date(review.sourceSentAt),
                  sourceBodySha256: review.sourceBodySha256,
                }
              : {}),
          })
          .returning({ id: ADDENDUM.id }),
        "addendum insert returned no row",
      );
      // ADR-0114 VN-D30: the sections it amends (a draft off, a note with no sealed rows or a foreign section id refuses the whole create).
      await amendments.name(
        t,
        {
          id: a.id,
          organizationId,
          encounterId,
          providerEntityId: r.providerEntityId,
          locationId: r.locationId,
          patientId: r.patientId,
        },
        args.amendsSectionIds ?? [],
        // The session's roles and the author's membership: the Part 2 verdict of the author who names a Part 2 section.
        { roles: args.roles ?? [], membershipId: args.authorMembershipId },
      );
      return { id: a.id, status: "draft" as const };
    });
  }

  async function resolveSiting(
    t: DbClient,
    summary: AdmissionSummary,
    authoredByMembershipId: string,
  ): Promise<{ providerEntityId: string; locationId: string }> {
    if (summary.providerEntityId && summary.locationId) {
      return { providerEntityId: summary.providerEntityId, locationId: summary.locationId };
    }
    const [m] = await t
      .select({
        providerEntityId: MEM.defaultProviderEntityId,
        locationIds: MEM.defaultLocationIds,
      })
      .from(MEM)
      .where(eq(MEM.id, authoredByMembershipId))
      .limit(1);
    const locs = Array.isArray(m?.locationIds) ? (m.locationIds as string[]) : [];
    if (!m?.providerEntityId || locs.length === 0) {
      throw new ValidationError(
        "encounter requires valid provider/location siting from the admission or authoring membership",
        [],
      );
    }
    return { providerEntityId: m.providerEntityId, locationId: locs[0] as string };
  }

  /**
   * Whether `viewer` may read this patient's 42 CFR Part 2 content: M39's per-actor verdict, the one the draft asks (a failure is not a "no",
   * see `readPinnedNote`). A document consumer has no viewer and is never entitled: documents are broadly readable (design 3.1).
   */
  const part2Entitlement =
    (organizationId: string, patientId: string, viewer: DraftViewer | null) =>
    async (): Promise<boolean> =>
      viewer !== null && draftSeams().part2DisclosureAllowed({ organizationId, patientId, viewer });

  /** Opens one pinned narrative envelope under the tenant DEK; unbound, the pinned narrative cannot be shown at all. */
  const openPinned = (organizationId: string) => (cipher: string) => {
    if (!narrativeCipher) {
      throw new EncounterStateError(
        "HEARTHNOTE_CIPHER_UNBOUND",
        "the encounter's narrative is pinned but no per-tenant DEK envelope is bound to open it",
      );
    }
    return withTenantDek("the pinned narrative could not be opened", () =>
      narrativeCipher.open(organizationId, cipher),
    );
  };

  /** The pinned (finalize-time or signed) narrative as `viewer` may see it (VN-D13: Part 2 sections withheld from a viewer without disclosure),
   *  or `null` when nothing is pinned yet or no DEK cipher is bound to open it. `final_cipher` is sealed under the tenant DEK (#122); never
   *  project it raw. With amendments (VN-D30) it is the CURRENT view, the latest signed text per section, and the history of each amended
   *  section comes with it; without any it is the sealed sections joined (the pin's final text, by the invariant the rows keep), or the pin
   *  itself when it has no sealed rows, and the history is `null`. */
  async function latestFinalPayload(
    t: DbClient,
    organizationId: string,
    encounter: {
      readonly id: string;
      readonly patientId: string;
      readonly authoredByMembershipId: string;
      readonly signedAt: Date | string | null;
    },
    viewer: DraftViewer,
  ): Promise<{
    readonly text: string | null;
    readonly view: StructuredNoteView | null;
    readonly history: NoteHistory | null;
  }> {
    if (!narrativeCipher) return { text: null, view: null, history: null };
    const original: NoteOriginal = {
      authoredByMembershipId: encounter.authoredByMembershipId,
      signedAt: encounter.signedAt === null ? null : new Date(encounter.signedAt),
    };
    const versions = await readNoteVersions(t, encounter.id, original, {
      open: openPinned(organizationId),
      entitled: part2Entitlement(organizationId, encounter.patientId, viewer),
    });
    return {
      text: versions?.current.text ?? null,
      view: versions?.current.structured ?? null,
      history: versions?.history ?? null,
    };
  }

  async function carePlanLinksFor(
    t: DbClient,
    encounterId: string,
  ): Promise<Array<{ problemId?: string; goalId?: string; interventionId?: string }>> {
    const rows = await t
      .select({
        problemId: LINK.problemId,
        goalId: LINK.goalId,
        interventionId: LINK.interventionId,
      })
      .from(LINK)
      .where(and(eq(LINK.encounterId, encounterId), isNull(LINK.removedAt)));
    return rows.map((r) => ({
      ...(r.problemId ? { problemId: r.problemId } : {}),
      ...(r.goalId ? { goalId: r.goalId } : {}),
      ...(r.interventionId ? { interventionId: r.interventionId } : {}),
    }));
  }

  async function workspaceFieldsFor(
    t: DbClient,
    organizationId: string,
    encounter: {
      readonly id: string;
      readonly patientId: string;
      readonly authoredByMembershipId: string;
      readonly signedAt: Date | string | null;
    },
    viewer: DraftViewer,
  ) {
    const encounterId = encounter.id;
    const [selection] = await t
      .select({ selections: SEL.selections })
      .from(SEL)
      .where(eq(SEL.encounterId, encounterId))
      .limit(1);
    const [vital] = await t
      .select({
        vitalsId: VITALS.id,
        bpSystolic: VITALS.bpSystolic,
        bpDiastolic: VITALS.bpDiastolic,
        heartRate: VITALS.heartRate,
        respiratoryRate: VITALS.respiratoryRate,
        temperature: VITALS.temperature,
        temperatureUnit: VITALS.temperatureUnit,
        spo2: VITALS.spo2,
        painScore: VITALS.painScore,
        painScale: VITALS.painScale,
        weight: VITALS.weight,
        weightUnit: VITALS.weightUnit,
        height: VITALS.height,
        heightUnit: VITALS.heightUnit,
        bmi: VITALS.bmi,
        bloodGlucose: VITALS.bloodGlucose,
        bloodGlucoseUnit: VITALS.bloodGlucoseUnit,
        clinicallyNotIndicatedFields: VITALS.clinicallyNotIndicatedFields,
        clinicallyNotIndicatedReason: VITALS.clinicallyNotIndicatedReason,
        capturedAt: VITALS.capturedAt,
      })
      .from(VITALS)
      .where(eq(VITALS.encounterId, encounterId))
      .orderBy(desc(VITALS.capturedAt))
      .limit(1);
    const [mileage] = await t
      .select({
        mileageId: MILEAGE.id,
        odometerStart: MILEAGE.odometerStart,
        odometerEnd: MILEAGE.odometerEnd,
        milesDriven: MILEAGE.milesDriven,
        source: MILEAGE.milesDrivenSource,
        manualOverrideReason: MILEAGE.manualOverrideReason,
        routeProposedMiles: MILEAGE.routeProposedMiles,
        capturedAt: MILEAGE.createdAt,
      })
      .from(MILEAGE)
      .where(eq(MILEAGE.encounterId, encounterId))
      .limit(1);
    const final = await latestFinalPayload(t, organizationId, encounter, viewer);
    return {
      selections: (selection?.selections as Record<string, unknown> | undefined) ?? null,
      finalDocumentation: final.text,
      finalDocumentationView: final.view,
      noteHistory: final.history,
      vitals: vital ? { ...vital, capturedAt: iso(vital.capturedAt) } : null,
      mileage: mileage ? { ...mileage, capturedAt: iso(mileage.capturedAt) } : null,
      carePlanLinks: await carePlanLinkRowsFor(t, encounterId),
      addenda: await addendumRowsFor(t, encounterId),
    };
  }

  /** GAP-027 — the encounter's addenda, oldest first; the UI enables edit/finalize/sign off this status. */
  async function addendumRowsFor(t: DbClient, encounterId: string) {
    const rows = await t
      .select({
        id: ADDENDUM.id,
        status: ADDENDUM.status,
        reason: ADDENDUM.reason,
        authoredByUserId: ADDENDUM.authoredByMembershipId,
        createdAt: ADDENDUM.createdAt,
        signedAt: ADDENDUM.signedAt,
        version: ADDENDUM.version,
      })
      .from(ADDENDUM)
      .where(eq(ADDENDUM.encounterId, encounterId))
      .orderBy(asc(ADDENDUM.createdAt), asc(ADDENDUM.id));
    // ADR-0114 VN-D30: where each amendment's own cosignature stands (one read for the encounter), and the sections each addendum names.
    const cosigns = new Map(
      (
        await t
          .select({ addendumId: ADDENDUM_COSIGN.addendumId, status: ADDENDUM_COSIGN.status })
          .from(ADDENDUM_COSIGN)
          .where(eq(ADDENDUM_COSIGN.encounterId, encounterId))
      ).map((request) => [request.addendumId, request.status]),
    );
    const named = await t
      .select({ addendumId: AMENDMENT.addendumId, sectionId: AMENDMENT.sectionId })
      .from(AMENDMENT)
      .where(eq(AMENDMENT.encounterId, encounterId))
      .orderBy(asc(AMENDMENT.sectionId));
    return rows.map((a) => ({
      id: a.id,
      status: a.status as "draft" | "finalized" | "signed",
      reason: a.reason,
      authoredByUserId: a.authoredByUserId,
      createdAt: iso(a.createdAt) ?? "",
      signedAt: iso(a.signedAt),
      version: Number(a.version),
      amendsSectionIds: named.filter((n) => n.addendumId === a.id).map((n) => n.sectionId),
      cosignStatus: cosignDisplayStatus(cosigns.get(a.id) ?? null),
    }));
  }

  async function carePlanLinkRowsFor(t: DbClient, encounterId: string) {
    const rows = await t
      .select({
        linkId: LINK.id,
        problemId: LINK.problemId,
        goalId: LINK.goalId,
        interventionId: LINK.interventionId,
      })
      .from(LINK)
      .where(and(eq(LINK.encounterId, encounterId), isNull(LINK.removedAt)));
    return rows.map((r) => ({
      linkId: r.linkId,
      problemId: r.problemId ?? null,
      goalId: r.goalId ?? null,
      interventionId: r.interventionId ?? null,
    }));
  }

  /** Is this encounter an F2F dual-write (§7.4 D1)? — the F2F type OR a linked M6 face-to-face row. */
  const isF2f = (r: typeof ENC.$inferSelect): boolean =>
    r.encounterType === "face_to_face" || r.faceToFaceEncounterId !== null;

  /** D10 — capture-or-replace the 0..1 mileage row for an encounter (captureMileage/editMileage share it). */
  async function captureMileageImpl(
    organizationId: string,
    encounterId: string,
    input: Parameters<EncounterRouteService["captureMileage"]>[2],
    actorMembershipId: string | null,
  ) {
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const t = tx as unknown as DbClient;
      const r = await loadEnc(t, encounterId);
      checkMutableForEdit({ status: r.status });
      await stampDraftOpened(t, organizationId, r, actorMembershipId);
      const plan = planMileageCapture(input);
      const [existing] = await t
        .select({ id: MILEAGE.id })
        .from(MILEAGE)
        .where(eq(MILEAGE.encounterId, encounterId))
        .limit(1);
      let mileageId: string;
      if (existing) {
        await t
          .update(MILEAGE)
          .set({
            odometerStart: input.odometerStart ?? null,
            odometerEnd: input.odometerEnd ?? null,
            milesDriven: plan.milesDriven,
            milesDrivenSource: plan.source,
            manualOverrideReason: input.manualOverrideReason ?? null,
            routeProposedMiles: input.routeProposedMiles ?? null,
          })
          .where(eq(MILEAGE.id, existing.id));
        mileageId = existing.id;
      } else {
        mileageId = firstOrThrow(
          await t
            .insert(MILEAGE)
            .values({
              organizationId,
              encounterId,
              odometerStart: input.odometerStart ?? null,
              odometerEnd: input.odometerEnd ?? null,
              milesDriven: plan.milesDriven,
              milesDrivenSource: plan.source,
              manualOverrideReason: input.manualOverrideReason ?? null,
              routeProposedMiles: input.routeProposedMiles ?? null,
            })
            .returning({ id: MILEAGE.id }),
          "mileage insert returned no row",
        ).id;
      }
      await emit(t, organizationId, "m8.mileage.captured", "mileage", mileageId, {
        encounterId,
        milesDriven: plan.milesDriven,
        source: plan.source,
      });
      return { mileageId, milesDriven: plan.milesDriven, source: plan.source };
    });
  }

  return {
    // ── Encounter reads ────────────────────────────────────────────────────────────────────────────
    async getEncounter(organizationId, encounterId, viewer = ANONYMOUS_VIEWER) {
      const { view, row } = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [r] = await t.select(encounterCols).from(ENC).where(eq(ENC.id, encounterId)).limit(1);
        if (!r) throw new NotFoundError("encounter"); // non-leaking 404 (mirrors the in-memory `load`)
        return {
          view: { ...toView(r), ...(await workspaceFieldsFor(t, organizationId, r, viewer)) },
          row: r,
        };
      });
      // Resolved AFTER the read tx: the M18 resolver opens its own tenant context (no nesting).
      return { ...view, evvBracketPresent: await evvBracketPresentFor(organizationId, row) };
    },
    // ── M22 render seam (§4.1 route 31) ────────────────────────────────────────────────────────────
    //
    // Was `final: ""` unconditionally, with a comment saying the real render arrived later. An empty
    // string is a RENDERABLE answer: a bound M22 renderer would have produced an empty note for a signed
    // encounter and reported success. A 404 is the truthful answer when there is no HearthNote to render
    // (#114) — the renderer can distinguish "nothing to render" from "here is nothing".
    async renderPayload(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        // The PINNED bytes win whenever they exist (#122). This is the whole point of the pin: what M22
        // prints and M28 exposes is what was assembled at finalize, not what the current corpus would
        // produce from the same selections today.
        //
        // ADR-0114 (VN-D13): a document is broadly readable and M22 has no per-document Part 2 signal for it (its retention class is the
        // template's), so the document consumer is never entitled: a note with a Part 2 derived section renders those sections withheld.
        const pinned = await readPinnedNote(t, encounterId, {
          open: openPinned(organizationId),
          entitled: part2Entitlement(organizationId, r.patientId, null),
        });
        if (pinned !== null) {
          return { encounterId: r.id, final: pinned.text, pinned: true };
        }
        // No pin: either a draft (nothing has been finalized, so a live preview is the only answer there
        // is) or a row finalized before #122 shipped. `pinned: false` is the difference, and it is on the
        // wire — a renderer must be able to tell a legal record from a preview of one.
        const [row] = await t.select().from(SEL).where(eq(SEL.encounterId, encounterId)).limit(1);
        if (!row) throw new NotFoundError("hearthnote_selection");
        return {
          encounterId: r.id,
          final: assembleSelections(
            r.encounterType,
            r.discipline,
            r.serviceDate,
            await openProse(organizationId, row),
          ),
          pinned: false,
        };
      });
    },
    async listEncounters(organizationId, filters = {}) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const conditions: SQL[] = [];
        if (filters.patientId) conditions.push(eq(ENC.patientId, filters.patientId));
        if (filters.patientIds) {
          if (filters.patientIds.length === 0) return { encounters: [] };
          conditions.push(inArray(ENC.patientId, [...filters.patientIds]));
        }
        if (filters.admissionId) conditions.push(eq(ENC.admissionId, filters.admissionId));
        if (filters.status) conditions.push(eq(ENC.status, filters.status));
        if (filters.authorId) conditions.push(eq(ENC.authoredByMembershipId, filters.authorId));
        if (filters.lateEntryTier)
          conditions.push(eq(ENC.lateEntryTier, filters.lateEntryTier as never));
        if (filters.from) conditions.push(gte(ENC.serviceDate, filters.from));
        if (filters.to) conditions.push(lte(ENC.serviceDate, filters.to));
        const rows = (await tx
          .select(encounterCols)
          .from(ENC)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(ENC.serviceDate), desc(ENC.id))) as EncounterRow[];
        const limit = filters.limit ?? rows.length;
        return { encounters: rows.slice(0, limit).map(toView) };
      });
    },
    async cosignatureQueue(organizationId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // The notes awaiting their cosigner (as before), each with its request.
        const noteRows = (await t
          .select(encounterCols)
          .from(ENC)
          .where(eq(ENC.status, "cosign_pending"))
          .orderBy(desc(ENC.signedAt), desc(ENC.id))) as EncounterRow[];
        const noteRequests = new Map(
          noteRows.length === 0
            ? []
            : (
                await t
                  .select({
                    id: COSIGN.id,
                    encounterId: COSIGN.encounterId,
                    status: COSIGN.status,
                    routedAt: COSIGN.routedAt,
                  })
                  .from(COSIGN)
                  .where(
                    inArray(
                      COSIGN.encounterId,
                      noteRows.map((r) => r.id),
                    ),
                  )
              ).map((request) => [request.encounterId, request]),
        );
        const notes = noteRows.map((r) => {
          const request = noteRequests.get(r.id);
          return {
            ...toView(r),
            cosign: {
              subject: "note" as const,
              addendumId: null,
              requestId: request?.id ?? null,
              status: request?.status ?? null,
              routedAt: request ? iso(request.routedAt) : null,
            },
          };
        });
        // ADR-0114 VN-D30: the amendments of signed notes awaiting THEIR cosigner. The parent stays signed or cosigned; the entry is the parent encounter.
        const amendmentRequests = await t
          .select()
          .from(ADDENDUM_COSIGN)
          .where(inArray(ADDENDUM_COSIGN.status, [...COSIGN_OPEN_STATUSES]))
          .orderBy(desc(ADDENDUM_COSIGN.routedAt), desc(ADDENDUM_COSIGN.id));
        const parentRows = new Map(
          amendmentRequests.length === 0
            ? []
            : (
                (await t
                  .select(encounterCols)
                  .from(ENC)
                  .where(
                    inArray(ENC.id, [...new Set(amendmentRequests.map((r) => r.encounterId))]),
                  )) as EncounterRow[]
              ).map((r) => [r.id, r]),
        );
        const amendments = amendmentRequests.flatMap((request) => {
          const parent = parentRows.get(request.encounterId);
          return parent === undefined
            ? []
            : [
                {
                  ...toView(parent),
                  cosign: {
                    subject: "addendum" as const,
                    addendumId: request.addendumId,
                    requestId: request.id,
                    status: request.status,
                    routedAt: iso(request.routedAt),
                  },
                },
              ];
        });
        return { encounters: [...notes, ...amendments] };
      });
    },
    // ADR-0113: "My notes" = the author's OPEN notes (draft + finalized, a finalized note is closed only once signed), each with
    // where it sits on the visit-note clock, from the same pure clock + tenant policy the gate and the alerts use.
    async myDrafts(organizationId, actorUserId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const policy = await readClosurePolicy(t, organizationId, "visit_note");
        const rows = (await t
          .select({ ...encounterCols, clockStartedAt: ENC.clockStartedAt })
          .from(ENC)
          .where(
            and(
              eq(ENC.organizationId, organizationId),
              eq(ENC.authoredByMembershipId, actorUserId),
              // A literal list (not bind parameters), as the closure reader does, so the planner can prove the partial-index predicate.
              sql`${ENC.status} IN ${OPEN_NOTE_STATUS_LIST_SQL}`,
            ),
          )
          .orderBy(desc(ENC.serviceDate), desc(ENC.id))) as (EncounterRow & {
          clockStartedAt: Date | null;
        })[];
        return {
          encounters: myNotesOf(
            rows.map((r) => ({ view: toView(r), clockStartedAt: r.clockStartedAt })),
            policy,
            clock(),
          ),
        };
      });
    },
    async billable(organizationId, encounterIds) {
      if (encounterIds.length === 0) return { billability: [] };
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select({ id: ENC.id, status: ENC.status })
          .from(ENC)
          .where(inArray(ENC.id, [...encounterIds]))) as { id: string; status: string }[];
        return {
          billability: rows.map((r) => ({
            encounterId: r.id,
            billable: r.status === "signed" || r.status === "cosigned",
          })),
        };
      });
    },
    async signedSince(organizationId, since) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select(encounterCols)
          .from(ENC)
          .where(gte(ENC.signedAt, new Date(since)))
          .orderBy(desc(ENC.signedAt), desc(ENC.id))) as EncounterRow[];
        return { encounters: rows.map(toView) };
      });
    },

    // ── Cosignature-request read (status derived from the D3 workflow row) ────────────────────────────
    async getCosignature(organizationId, encounterId, addendumId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
        readCosignatureStatus(tx as unknown as DbClient, cosignSubjectOf(encounterId, addendumId)),
      );
    },

    // ── Draft creation (§2.3 genesis; route 1) ───────────────────────────────────────────────────────
    async createDraft(organizationId, actorUserId, args) {
      // Resolved BEFORE the write transaction: the seam's Drizzle store opens its own tenant context,
      // and nesting that inside an open `withOrgContext` would set the GUC on an already-bound
      // connection (M10's `admissionSiting` records the same rule).
      const admission = await admissionSummaryFor(organizationId, args.admissionId);
      // Likewise resolved before the write tx (the VisitReader seam opens its own tenant context).
      const clockPlan = await creationClockPlan(organizationId, args.visitId, actorUserId);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // §2.7 pre-write guards (the rest — volunteer assignment, service-date-after-admission — thread
        // their seam facts when the interface carries them; the DB CHECKs backstop the same envelopes).
        checkEncounterDisciplinePair({
          encounterType: args.encounterType,
          discipline: args.discipline,
        });
        checkServiceDateNotFuture({
          serviceDate: args.serviceDate,
          today: new Date().toISOString().slice(0, 10) as LocalDate,
        });
        validateAdmissionForService(organizationId, args.patientId, args.serviceDate, admission);
        // F-064 — the ARCH-011 siting 0128 deferred: from the admission, else the author's membership.
        const siting = await resolveSiting(t, admission, actorUserId);
        const row = firstOrThrow(
          await t
            .insert(ENC)
            .values({
              organizationId,
              ...siting,
              patientId: args.patientId,
              admissionId: args.admissionId,
              visitId: args.visitId ?? null,
              encounterType: args.encounterType,
              discipline: args.discipline,
              authoredByMembershipId: actorUserId, // stored as the authoring membership (see toView)
              serviceDate: args.serviceDate,
              faceToFaceEncounterId: args.faceToFaceEncounterId ?? null,
              bereavementPlanId: args.bereavementPlanId ?? null,
              status: "draft",
              // Only a telephonic encounter type implies a modality at creation; confirmed_at stays NULL.
              visitModality: seedModalityFor({ encounterType: args.encounterType }),
              // ADR-0113: the clock columns by plan (at creation, at the visit's arrival, or left to the M17 start event), in this INSERT.
              ...(await creationClockColumns(t, organizationId, clockPlan)),
            })
            .returning(),
          "encounter insert returned no row",
        );
        await emit(t, organizationId, "m8.encounter.created", "encounter", row.id, {
          encounterId: row.id,
          patientId: row.patientId,
          admissionId: row.admissionId,
          ...(row.visitId ? { visitId: row.visitId } : {}),
          encounterType: row.encounterType,
          discipline: row.discipline,
          authoredByMembershipId: row.authoredByMembershipId,
          serviceDate: row.serviceDate,
        });
        return {
          id: row.id,
          status: "draft",
          templateKey: `${row.discipline}_${row.encounterType}_v1`,
          templateVersion: "v1",
          version: Number(row.version),
        };
      });
    },

    // ── HearthNote selection edit (§2.3/§2.6 — persists the tree, bumps the optimistic-lock version) ──
    //
    // This used to bump `version`, stamp `updated_at` and return `layer1Preview: ""` — the clinician's
    // note accepted with a 200 and dropped on the floor (#114). It now writes the row the table was
    // shaped for. One row per parent (mig 0225 made that index genuinely unique), so this is an upsert.
    async updateSelections(organizationId, encounterId, ifVersion, input, actorMembershipId) {
      const { stored, prose } = splitFreeText(input.sections);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId, { lock: true });
        checkMutableForEdit({ status: r.status });
        checkVersion({ expected: ifVersion, actual: Number(r.version) });
        await stampDraftOpened(t, organizationId, r, actorMembershipId);
        // Assemble BEFORE the write: an unknown code or section must reject the PATCH, not be stored and
        // discovered by whoever later tries to render the note.
        const layer1Preview = assembleSelections(
          r.encounterType,
          r.discipline,
          r.serviceDate,
          input.sections,
        );
        const freeTextCipherValue = await sealProse(organizationId, prose);
        const updated = firstOrThrow(
          await t
            .update(ENC)
            .set({ version: ifVersion + 1, updatedAt: new Date() })
            .where(and(eq(ENC.id, encounterId), eq(ENC.version, ifVersion)))
            .returning({ version: ENC.version }),
          "updateSelections matched no row (stale write)",
        );
        await t
          .insert(SEL)
          .values({
            organizationId,
            providerEntityId: r.providerEntityId,
            locationId: r.locationId,
            encounterId,
            templateKey: hearthnoteTemplateKey(r.encounterType, r.discipline),
            templateVersion: VOCAB_VERSION,
            selections: { sections: stored },
            freeTextCipher: freeTextCipherValue,
          })
          .onConflictDoUpdate({
            target: SEL.encounterId,
            targetWhere: isNotNull(SEL.encounterId),
            set: {
              selections: { sections: stored },
              freeTextCipher: freeTextCipherValue,
              templateKey: hearthnoteTemplateKey(r.encounterType, r.discipline),
              templateVersion: VOCAB_VERSION,
              updatedAt: new Date(),
              version: sql`${SEL.version} + 1`,
            },
          });
        return { version: Number(updated.version), layer1Preview };
      });
    },

    /**
     * F-063 — the authoring menu. `@chartwarden/narrative-vocab`'s `entriesFor` is documented as "the
     * entries a `(encounterType, discipline)` menu surfaces … so the selection UI and the template
     * engine see the same deterministic ordering", and no route ever surfaced it — so there was no
     * selection UI. Derived from the encounter's OWN type/discipline (never from the caller), so the
     * menu a client is offered and the rules `assembleSelections` enforces on the way back in cannot
     * be different rules. ADR-0114: the draft phrases of the 2026.11.0 corpus are unreviewed wording, so the menu carries them only
     * for a tenant whose visit-note draft switch is on; with it off the menu is what it was before that corpus.
     */
    async getTemplate(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId); // non-leaking 404 before the menu is built
        const draftWording = await isVisitNoteDraftEnabled(t, organizationId);
        return {
          encounterId,
          ...buildTemplateMenu(r.encounterType, r.discipline, { draftWording }),
        };
      });
    },

    /**
     * F-063 — read the mileage row back. `POST`/`PATCH .../mileage` wrote a real row and no route
     * returned it, so recorded travel left the clinician's screen for good — the same write-only shape
     * #92 fixed for vitals, on the table beside it. `null` (not 404) when no mileage was recorded: the
     * encounter exists and has none, which is an answer rather than an absence.
     */
    async getMileage(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadEnc(t, encounterId); // 404s on unknown/cross-tenant exactly as getEncounter does
        const [row] = await t
          .select()
          .from(MILEAGE)
          .where(eq(MILEAGE.encounterId, encounterId))
          .limit(1);
        if (!row) return null;
        return {
          mileageId: row.id,
          encounterId,
          odometerStart: row.odometerStart,
          odometerEnd: row.odometerEnd,
          milesDriven: row.milesDriven,
          source: row.milesDrivenSource,
          manualOverrideReason: row.manualOverrideReason,
          routeProposedMiles: row.routeProposedMiles,
          recordedAt: row.createdAt.toISOString(),
        };
      });
    },

    async getSelections(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId); // non-leaking 404 before the child read
        const [row] = await t.select().from(SEL).where(eq(SEL.encounterId, encounterId)).limit(1);
        const sections = row ? await openProse(organizationId, row) : [];
        return {
          templateKey: hearthnoteTemplateKey(r.encounterType, r.discipline),
          vocabVersion: VOCAB_VERSION,
          sections,
          layer1Preview: assembleSelections(r.encounterType, r.discipline, r.serviceDate, sections),
          // The If-Match contract protects the encounter aggregate, not its HearthNote child row.
          // `hearthnote_selection.version` remains internal bookkeeping; returning it here causes a
          // false 412 whenever the child and encounter counters differ.
          version: Number(r.version),
        };
      });
    },

    /**
     * #92 — read back every vitals set on one encounter. Until this existed the `vitals` table was
     * write-only through the public API: `POST`/`PATCH .../vitals` wrote real rows and no route
     * returned them, so a recorded blood pressure left the clinician's screen for good.
     *
     * Runs under `withOrgContext` like every other read here, so RLS scopes the rows by tenant even
     * though the query filters on `encounter_id` alone. The encounter is loaded FIRST so an unknown
     * or cross-tenant id 404s exactly as `getEncounter` does, rather than returning an empty list —
     * an empty list and "not yours" must not be the same answer to the caller.
     */
    async listVitals(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadEnc(t, encounterId); // throws NotFoundError on unknown/cross-tenant (non-leaking)
        const rows = await t
          .select()
          .from(VITALS)
          .where(eq(VITALS.encounterId, encounterId))
          .orderBy(desc(VITALS.capturedAt), desc(VITALS.id));
        return {
          encounterId,
          vitals: rows.map((row) =>
            toVitalsView(row.id, encounterId, {
              capturedAt: row.capturedAt.toISOString(),
              bmi: row.bmi,
              input: {
                bpSystolic: row.bpSystolic ?? undefined,
                bpDiastolic: row.bpDiastolic ?? undefined,
                heartRate: row.heartRate ?? undefined,
                respiratoryRate: row.respiratoryRate ?? undefined,
                temperature: row.temperature ?? undefined,
                temperatureUnit: row.temperatureUnit ?? undefined,
                spo2: row.spo2 ?? undefined,
                painScore: row.painScore ?? undefined,
                painScale: row.painScale ?? undefined,
                weight: row.weight ?? undefined,
                weightUnit: row.weightUnit ?? undefined,
                height: row.height ?? undefined,
                heightUnit: row.heightUnit ?? undefined,
                bloodGlucose: row.bloodGlucose ?? undefined,
                bloodGlucoseUnit: row.bloodGlucoseUnit ?? undefined,
                clinicallyNotIndicatedFields: row.clinicallyNotIndicatedFields ?? undefined,
                clinicallyNotIndicatedReason: row.clinicallyNotIndicatedReason ?? undefined,
              },
            }),
          ),
        };
      });
    },

    // ── Vitals authoring (§2.2, §3.3 `vitals`) ─────────────────────────────────────────────────────────
    async captureVitals(organizationId, encounterId, input, actorMembershipId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        await stampDraftOpened(t, organizationId, r, actorMembershipId);
        const plan = planVitalsCapture(input); // validates envelopes + CNI reason (§2.2)
        const v = firstOrThrow(
          await t
            .insert(VITALS)
            .values({
              organizationId,
              encounterId,
              capturedAt: new Date(),
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
              bmi: plan.bmi,
              bloodGlucose: input.bloodGlucose ?? null,
              bloodGlucoseUnit: input.bloodGlucoseUnit ?? null,
              clinicallyNotIndicatedFields: input.clinicallyNotIndicatedFields
                ? [...input.clinicallyNotIndicatedFields]
                : null,
              clinicallyNotIndicatedReason: input.clinicallyNotIndicatedReason ?? null,
            })
            .returning({ id: VITALS.id }),
          "vitals insert returned no row",
        );
        await emit(t, organizationId, "m8.vitals.captured", "vitals", v.id, {
          encounterId,
          vitalsId: v.id,
          fieldsCaptured: [...plan.fieldsCaptured],
          abnormalFlags: [...plan.abnormalFlags],
        });
        return {
          vitalsId: v.id,
          fieldsCaptured: plan.fieldsCaptured,
          abnormalFlags: plan.abnormalFlags,
          bmi: plan.bmi,
        };
      });
    },
    async editVitals(organizationId, encounterId, vitalsId, input, actorMembershipId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        await stampDraftOpened(t, organizationId, r, actorMembershipId);
        const [existing] = await t
          .select({ id: VITALS.id })
          .from(VITALS)
          .where(and(eq(VITALS.id, vitalsId), eq(VITALS.encounterId, encounterId)))
          .limit(1);
        if (!existing) throw new NotFoundError("vitals");
        const plan = planVitalsCapture(input);
        await t
          .update(VITALS)
          .set({
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
            bmi: plan.bmi,
            bloodGlucose: input.bloodGlucose ?? null,
            bloodGlucoseUnit: input.bloodGlucoseUnit ?? null,
            clinicallyNotIndicatedFields: input.clinicallyNotIndicatedFields
              ? [...input.clinicallyNotIndicatedFields]
              : null,
            clinicallyNotIndicatedReason: input.clinicallyNotIndicatedReason ?? null,
          })
          .where(eq(VITALS.id, vitalsId));
        await emit(t, organizationId, "m8.vitals.captured", "vitals", vitalsId, {
          encounterId,
          vitalsId,
          fieldsCaptured: [...plan.fieldsCaptured],
          abnormalFlags: [...plan.abnormalFlags],
        });
        return {
          vitalsId,
          fieldsCaptured: plan.fieldsCaptured,
          abnormalFlags: plan.abnormalFlags,
          bmi: plan.bmi,
        };
      });
    },

    // ── Mileage authoring (§2.2 D10 — 0..1 per encounter; capture and edit share the upsert) ────────────
    async captureMileage(organizationId, encounterId, input, actorMembershipId) {
      return captureMileageImpl(organizationId, encounterId, input, actorMembershipId);
    },
    async editMileage(organizationId, encounterId, input, actorMembershipId) {
      return captureMileageImpl(organizationId, encounterId, input, actorMembershipId);
    },

    // ── Care-plan links / EVV-missing (§2.3 draft-time edits) ──────────────────────────────────────────
    /**
     * F-064 (#159) — persist the link.
     *
     * This used to parse the body in the route, discard it, insert nothing, and return the ENCOUNTER's
     * own id as `linkId` with a 201. Two things were missing and only one was written down: the route
     * did not thread the M7 refs, AND `encounter_care_plan_link.provider_entity_id` / `location_id`
     * were NOT NULL while the encounter they would be copied from carried null in both — migration 0128
     * relaxed that pair on every other encounter satellite and left this table out. Migration 0231
     * finishes that list, and `createDraft` now stamps the encounter's siting from M6.
     */
    async addCarePlanLink(organizationId, actorMembershipId, encounterId, input, actorRoles) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // Locked: the section PUT reads the live links and writes its own, and the duplicate check below must see its committed rows.
        const r = await loadEnc(t, encounterId, { lock: true });
        checkMutableForEdit({ status: r.status });
        // 422 naming the field, rather than the raw `23514` the `at_least_one` CHECK would raise.
        assertAtLeastOneCarePlanRef(input);
        // The refs must name elements of THIS patient's active plan, relevant to this encounter's
        // (type × discipline), and a goal/intervention must hang off the problem it is linked with —
        // otherwise a link could claim a visit addressed a problem on some other patient's plan.
        // The audience is the ACTOR (session roles + membership id): the store resolves the same per-actor Part 2
        // verdict the picker route used, so what the picker offers is exactly what this check accepts (an RN case
        // manager can link a Part 2 problem where no release names others; a nurse the release does not name cannot
        // link one even if she holds its uuid). The verdict is never asserted here, only the identity is passed.
        const elements = await getCarePlanReader().relevantElementsForEncounter(
          r.patientId as PatientId,
          r.encounterType,
          r.discipline as never,
          r.admissionId,
          { actor: { roles: actorRoles, membershipId: actorMembershipId } },
        );
        if (!elements || elements.patientId !== r.patientId) {
          throw new ValidationError(
            "no active care plan elements are available for this encounter",
            [],
          );
        }
        const problem = input.problemId
          ? elements.problems.find((p) => p.problemId === input.problemId)
          : null;
        const goal = input.goalId ? elements.goals.find((g) => g.goalId === input.goalId) : null;
        const intervention = input.interventionId
          ? elements.interventions.find((i) => i.interventionId === input.interventionId)
          : null;
        if (input.problemId && !problem)
          throw new ValidationError("problem is not valid for this encounter", []);
        if (input.goalId && !goal)
          throw new ValidationError("goal is not valid for this encounter", []);
        if (input.interventionId && !intervention) {
          throw new ValidationError("intervention is not valid for this encounter", []);
        }
        if (goal && input.problemId && goal.problemId !== input.problemId) {
          throw new ValidationError("goal does not belong to the linked problem", []);
        }
        if (intervention && input.problemId && intervention.problemId !== input.problemId) {
          throw new ValidationError("intervention does not belong to the linked problem", []);
        }
        // Idempotent: re-linking the same (problem, goal, intervention) triple returns the live link.
        const [existing] = await t
          .select()
          .from(LINK)
          .where(
            and(
              eq(LINK.encounterId, encounterId),
              isNull(LINK.removedAt),
              input.problemId ? eq(LINK.problemId, input.problemId) : isNull(LINK.problemId),
              input.goalId ? eq(LINK.goalId, input.goalId) : isNull(LINK.goalId),
              input.interventionId
                ? eq(LINK.interventionId, input.interventionId)
                : isNull(LINK.interventionId),
            ),
          )
          .limit(1);
        if (existing) return toCarePlanLinkView(existing);
        const row = firstOrThrow(
          await t
            .insert(LINK)
            .values({
              organizationId,
              providerEntityId: r.providerEntityId,
              locationId: r.locationId,
              encounterId,
              problemId: input.problemId ?? null,
              goalId: input.goalId ?? null,
              interventionId: input.interventionId ?? null,
            })
            .returning(),
          "encounter_care_plan_link insert returned no row",
        );
        return toCarePlanLinkView(row);
      });
    },
    /**
     * F-064 — a SOFT invalidate, and a real 404.
     *
     * The route loaded the encounter, checked it was mutable, and returned 204 having removed nothing:
     * `chartwarden_app` holds DELETE on no M8 table (§3.6 append-only, uniform across all ten) and there was
     * no column to mark instead. Migration 0231 adds the `removed_at` / `removed_by_membership_id`
     * pair, so the row survives for the M4 write-audit trail while the link stops counting.
     *
     * A link that is absent or already removed is a 404. The old 204 was indistinguishable from a
     * working delete, which is the whole defect.
     */
    async removeCarePlanLink(organizationId, actorMembershipId, encounterId, linkId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId, { lock: true });
        checkMutableForEdit({ status: r.status });
        const rows = await t
          .update(LINK)
          .set({ removedAt: new Date(), removedByMembershipId: actorMembershipId })
          .where(
            and(
              eq(LINK.id, linkId),
              eq(LINK.encounterId, encounterId),
              eq(LINK.organizationId, organizationId),
              isNull(LINK.removedAt),
            ),
          )
          .returning({ id: LINK.id });
        if (rows.length === 0) {
          throw new NotFoundError(`Care-plan link ${linkId} not found on encounter ${encounterId}`);
        }
      });
    },
    /**
     * F-064 — the read that never existed.
     *
     * Even once links persist, `encounter_care_plan_link` would be write-only without this: there was
     * no `GET`, and `GET /api/v1/encounters/{id}` does not project the links. The same shape #92 fixed
     * for vitals and F-063 for mileage.
     */
    async listCarePlanLinks(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadEnc(t, encounterId); // 404 before the read if absent / cross-tenant
        const rows = await t
          .select()
          .from(LINK)
          .where(
            and(
              eq(LINK.encounterId, encounterId),
              eq(LINK.organizationId, organizationId),
              isNull(LINK.removedAt),
            ),
          )
          .orderBy(asc(LINK.createdAt), asc(LINK.id));
        return { links: rows.map(toCarePlanLinkView) };
      });
    },
    async documentEvvMissing(organizationId, encounterId, reason) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        await t
          .update(ENC)
          .set({
            evvBracketState: "evv_missing_documented",
            evvMissingReason: reason,
            updatedAt: new Date(),
          })
          .where(eq(ENC.id, encounterId));
        return { evvBracketState: "evv_missing_documented" };
      });
    },

    // ── Finalize (§2.3 — Layer-3 gate preview + pin the vocab version D11) ─────────────────────────────
    async finalize(organizationId, encounterId, at, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // Locked first: the draft read below, and the pin written from it, must be of what every earlier section PUT committed.
        const r = await loadEnc(t, encounterId, { lock: true });
        assertLegalFrom(r.status, "finalize");
        // The finalize route is `IS_AUTHOR`-guarded (only the author reaches it), so the writer here is the author.
        await stampDraftOpened(t, organizationId, r, r.authoredByMembershipId);
        // GAP-013 §2.5 — the tier is COMPUTED here from service_date vs the org-local day and reified on the
        // row; a note > 24h late must carry the clinician's reason (422 LATE_ENTRY_REASON_REQUIRED). The
        // significant / administrative tiers cannot be written to the column before their override exists
        // (the encounter_*_consistency CHECKs), so they are recomputed — and gated — at sign.
        const late = resolveLateEntry({
          serviceDate: r.serviceDate as LocalDate,
          asOfDate: await orgLocalToday(t, organizationId),
          persistedReason: r.lateEntryReason,
          suppliedReason: args?.lateEntryReason ?? null,
          significantOverridePresent: r.significantLateOverrideBy !== null,
          administrativeOverridePresent: r.administrativeOverrideBy !== null,
          requireOverride: false,
        });
        const reifiedTier = reifiableTier(r.lateEntryTier, late.tier);
        // ADR-0114: the author's visit-note draft (null when the tenant has the switch off).
        const draft = await noteDraft.read(t, r, args?.viewer ?? ANONYMOUS_VIEWER);
        // §2.3 — the gate runs as a PREVIEW here: a failure raises the 422 + remediation list and the
        // row stays in draft, which is the transition not happening at all.
        const trans = transitionEncounter(r.status, {
          type: "finalize",
          gatePreviewPassed: await gateEncounter(t, r, "finalize", draft),
          at,
        });
        // §2.7 D11 — the vocabulary version guard, which had never run: `checkVocabVersion` has existed
        // in `lifecycle/validation.ts` since M8-T04 and was called by no production path (#128).
        //
        // The draft records the corpus it was authored against in `hearthnote_selection.template_version`
        // (written on every selections PATCH). If a corpus release ships between the last edit and the
        // finalize, the selections were built from phrases this build may no longer render identically —
        // which is the exact scenario §2.7 puts a 409 VOCAB_VERSION_MISMATCH on. Re-opening and saving
        // the draft re-stamps it and clears the refusal, so the remedy is in the clinician's hands.
        //
        // A draft with NO selection row has nothing to disagree about (an empty note the §2.6 gate has
        // already judged), so there is nothing to compare and the check does not run.
        const pin = activeVocabPin();
        const [selRow] = await t
          .select({ templateVersion: SEL.templateVersion })
          .from(SEL)
          .where(eq(SEL.encounterId, encounterId))
          .limit(1);
        if (selRow !== undefined) {
          checkVocabVersion({
            pinnedVersionId: selRow.templateVersion,
            activeVersionId: pin.version,
          });
        }
        // The D11 pin, resolved ONCE: the encounter row, the assembled output and the outbox event all
        // carry the same value, so the version the note was assembled under cannot disagree with the
        // version the encounter claims. Set at FIRST finalize and immutable thereafter, so an already
        // pinned row keeps the id it was signed under.
        const vocabVersionId = r.vocabVersionId ?? pin.id;
        const updated = firstOrThrow(
          await t
            .update(ENC)
            .set({
              status: trans.to,
              vocabVersionId, // D11 pin (immutable thereafter)
              lateEntryTier: reifiedTier,
              ...(late.reason !== null ? { lateEntryReason: late.reason } : {}),
              version: Number(r.version) + 1,
              updatedAt: new Date(),
            })
            .where(and(eq(ENC.id, encounterId), eq(ENC.status, r.status)))
            .returning({ version: ENC.version }),
          "finalize matched no row: the encounter changed status since it was loaded",
        );
        // The `persist_assembled_output` effect the machine has declared since M8-T04 (#122).
        await pinAssembledOutput(t, organizationId, {
          kind: "primary_finalize",
          encounterId,
          addendumId: null,
          providerEntityId: r.providerEntityId,
          locationId: r.locationId,
          encounterType: r.encounterType,
          discipline: r.discipline,
          serviceDate: r.serviceDate,
          vocabVersionId,
          // The gate has passed, so every drafted section is resolved: the pin carries the confirmed text, not Layer 1 alone.
          ...(draft === null
            ? {}
            : {
                narrative: noteDraft.narrativeOf(draft),
                part2Derived: noteDraft.part2DerivedOf(draft),
              }),
        });
        await emit(t, organizationId, "m8.encounter.finalized", "encounter", encounterId, {
          encounterId,
          vocabVersionId,
          layer2Involved: false,
          lateEntryTier: late.tier,
        });
        return { status: "finalized", version: Number(updated.version) };
      });
    },

    // ── HearthNote Layer-2 (§2.6 D5) ──────────────────────────────────────────────────────────────────
    //
    // Was: return `r.id` — the ENCOUNTER's own id — as a `modificationId`, and echo back whatever id the
    // decision route was handed. Nothing wrote `hearthnote_llm_modification`, so a caller invoked
    // enhancement, received an id that identified something else, recorded a per-passage decision against
    // it, and got a 200 both times. Nothing happened, twice, successfully (#123).
    async enhanceHearthnote(organizationId, encounterId) {
      const r = await loadRow(organizationId, encounterId);
      if (!r) throw new NotFoundError("encounter");
      // The D5 ladder is the answer, and it is the SAME resolution `finalize` reifies on the assembled
      // output — so the row and the route cannot disagree about why Layer 2 did not run.
      return { enhanced: false, reason: resolveLayer2Eligibility() };
    },
    async recordModificationDecision(organizationId, encounterId, modId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadEnc(t, encounterId); // non-leaking 404 for the parent first
        // A real read, org-scoped, RLS-backstopped. `hearthnote_llm_modification` is written by nothing
        // today (the Layer-2 dispatch is unbuilt), so in practice this always 404s — but it 404s because
        // the row is ABSENT, not because the route decided to. The live suite inserts one and gets a 200,
        // which is what distinguishes this from a hard-coded refusal.
        const [row] = await t
          .select({ id: LLM.id })
          .from(LLM)
          .innerJoin(OUT, eq(OUT.id, LLM.assembledOutputId))
          .where(and(eq(LLM.id, modId), eq(OUT.encounterId, encounterId)))
          .limit(1);
        if (!row) throw new NotFoundError("hearthnote_llm_modification");
        // The DECISION itself is not recorded yet, and cannot be from this contract: the column is
        // `per_passage_decisions` and `ModificationDecisionSchema` carries no passage id. Passage
        // identity is created by the Layer-1↔Layer-2 diff, so there is nothing to key a decision to
        // until the dispatch that produces that diff exists (#123's remaining half).
        return { modificationId: row.id };
      });
    },

    // ── Sign (§2.3 — the LOCKED clinical-record trigger; §7.4 D1 F2F dual-write + LPN/CHHA cosign) ──────
    async sign(organizationId, encounterId, actor, args) {
      // GAP-070 — the M18 bracket is resolved BEFORE the write tx (the resolver opens its own tenant
      // context; nesting it would bind the GUC on an already-bound connection).
      const { resolution: evvResolution, askFailure: evvAskFailure } = await resolveEvvBracketFor(
        organizationId,
        encounterId,
      );
      // The real caller is the audit actor: this UPDATE carries the modality, its confirmer and the documented
      // times, so it must not be audited with a NULL actor (the confirm route does the same).
      return withOrgContext(db, { organizationId, userId: actor.userId ?? "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // Locked first: the signer's draft below is read after every section PUT that held the row has committed, and a second sign
        // of the same encounter waits here and then finds it already signed.
        const r = await loadEnc(t, encounterId, { lock: true });
        // GAP-028 — defence in depth behind the route's `is_author` guard: only the author signs.
        if (r.authoredByMembershipId !== actor.membershipId) {
          throw new ForbiddenError("only the author of an encounter may sign it");
        }
        assertLegalFrom(r.status, "sign");
        // Before either status UPDATE below (the stamp only touches open notes): a signed note always carries a clock.
        await stampDraftOpened(t, organizationId, r, actor.membershipId);
        const now = new Date();
        const admission = await admissionSummaryFor(organizationId, r.admissionId);
        validateAdmissionForService(
          organizationId,
          r.patientId,
          r.serviceDate as LocalDate,
          admission,
        );
        // GAP-013 §2.5 — the tier is recomputed at SIGN from service_date vs the org-local day (it can only
        // have risen since finalize): the reason must be on the row, and a significant / administrative
        // tier must already carry its recorded override. A higher override satisfies a lower tier.
        const late = resolveLateEntry({
          serviceDate: r.serviceDate as LocalDate,
          asOfDate: await orgLocalToday(t, organizationId),
          persistedReason: r.lateEntryReason,
          suppliedReason: args.lateEntryReason ?? null,
          significantOverridePresent:
            r.significantLateOverrideBy !== null || r.administrativeOverrideBy !== null,
          administrativeOverridePresent: r.administrativeOverrideBy !== null,
          requireOverride: true,
        });
        const lateColumns = {
          lateEntryTier: reifiableTier(r.lateEntryTier, late.tier),
          ...(late.reason !== null ? { lateEntryReason: late.reason } : {}),
        };
        // The REAL caller signs, not the encounter's author (that was the pre-fix bug — see the
        // module-header compromise list above, item (2)).
        const signedByMembershipId = actor.membershipId;
        const evvAtSign = deriveEvvAtSign(r.evvBracketState, evvResolution);
        const evvBracketState = evvAtSign.state;
        const provenance = await resolveSignatureProvenance(organizationId, actor.sessionId);
        if (!r.providerEntityId || !r.locationId) {
          throw new EncounterStateError(
            "ILLEGAL_TRANSITION",
            "encounter must be sited (provider entity + location) before it can be signed",
          );
        }
        const siting = { providerEntityId: r.providerEntityId, locationId: r.locationId };
        // ADR-0114: the SIGNER's own draft, recomputed now as of the visit time (never the author's: redaction can differ). Any drafted
        // section that is unresolved or no longer matches its confirmation refuses the sign with 409 DRAFT_SECTION_STALE, before any write.
        const draft = await noteDraft.read(t, r, {
          roles: actor.roles ?? [],
          membershipId: actor.membershipId,
        });
        assertResolved(draft);
        // The draft off at sign over a pin it produced that carries Part 2 text: nothing to seal rows from, so refused (LOW-4).
        await noteDraft.assertDraftNotWithdrawn(t, r, draft);
        const careplanLinks = await carePlanLinksFor(t, encounterId);
        // The pinned narrative is sealed under the tenant DEK (#122); it is NOT copied into the outbox
        // payload in the clear. M22 renders through `renderPayload` (route 31), which opens the pin.
        const finalPayload = "";

        // §7.4 D1 — an F2F encounter signs as one atomic dual-write (M8 note + the M6 attestation row).
        // The plan throws on a failed gate / stale step-up / missing M6 id → neither side is written.
        // The M6 write descriptor (plan.attestation) is handed to M6's writer by the composition root in
        // prod; this slice performs the M8 side only (no cross-module write edge).
        if (isF2f(r)) {
          const gatePassed = await gateEncounter(t, r, "sign", draft);
          const plan = planF2fDualWrite({
            status: r.status,
            encounterId: r.id,
            faceToFaceEncounterId: (r.faceToFaceEncounterId ?? null) as Parameters<
              typeof planF2fDualWrite
            >[0]["faceToFaceEncounterId"],
            discipline: r.discipline,
            gatePassed,
            stepUpFresh: provenance.stepUpFresh,
            at: args.at,
          });
          const delivery = await deliveryColumnsAtSign(
            t,
            organizationId,
            r,
            args,
            evvAtSign,
            evvAskFailure,
            signedByMembershipId,
          );
          // ADR-0114: the signed note's text and its sealed section rows, in this transaction (no-op with the draft off). BEFORE the status
          // flips: migration 1521 freezes the pinned narrative once the encounter reads signed, so the pin is the last write it accepts.
          await noteDraft.sealSigned(t, r, draft);
          firstOrThrow(
            await t
              .update(ENC)
              .set({
                status: plan.encounter.to,
                signedAt: now,
                updatedAt: now,
                ...lateColumns,
                ...evvPersistence(evvAtSign),
                ...delivery,
              })
              .where(and(eq(ENC.id, encounterId), eq(ENC.status, r.status)))
              .returning({ id: ENC.id }),
            SIGN_LOST_RACE,
          );
          await t.insert(SIG).values({
            organizationId,
            ...siting,
            encounterId,
            kind: "primary",
            signedByMembershipId,
            signedByDiscipline: r.discipline,
            signedAt: now,
            method: provenance.method,
            sessionId: actor.sessionId,
            stepUpAuthAt: provenance.stepUpAuthAt,
            attestationText: PRIMARY_ATTESTATION_TEXT,
            layer2InvolvedAtSigning: false,
          });
          await emit(t, organizationId, "m8.encounter.signed", "encounter", encounterId, {
            encounterId,
            patientId: r.patientId,
            admissionId: r.admissionId,
            ...(r.visitId ? { visitId: r.visitId } : {}),
            encounterType: r.encounterType,
            discipline: r.discipline,
            signedByMembershipId,
            signedAt: now.toISOString(),
            lateEntryTier: late.tier,
            layer2Involved: false,
            evvBracketState,
            evvMissingReason: r.evvMissingReason,
            requiresCosign: false,
            careplanLinks,
            documentRenderPayload: { final: finalPayload, addenda: [] },
          });
          await emitOrphanIfUnlinked(t, organizationId, r, now);
          return { status: "signed", signedAt: now.toISOString(), cosignatureRequestId: null };
        }

        // §2.6 check 10 — resolved ONLY for the disciplines that route a cosignature; an RN/MD/NP note
        // never asks M5 a question whose answer it would not use.
        const cosignerMembershipId = requiresCosignature(r.discipline)
          ? await cosignerMembershipIdFor(organizationId, r.patientId, signedByMembershipId)
          : null;
        const trans = transitionEncounter(r.status, {
          type: "sign",
          discipline: r.discipline,
          gatePassed: await gateEncounter(t, r, "sign", draft),
          stepUpFresh: provenance.stepUpFresh,
          isF2f: false,
          f2fDualWriteSatisfied: true,
          eligibleCosignerExists: cosignerMembershipId !== null,
          at: args.at,
        });
        const requiresCosign = trans.to === "cosign_pending";
        const delivery = await deliveryColumnsAtSign(
          t,
          organizationId,
          r,
          args,
          evvAtSign,
          evvAskFailure,
          signedByMembershipId,
        );
        // ADR-0114: the signed note's text and its sealed section rows, in this transaction (no-op with the draft off). BEFORE the status
        // flips: migration 1521 freezes the pinned narrative once the encounter reads signed, so the pin is the last write it accepts.
        await noteDraft.sealSigned(t, r, draft);
        firstOrThrow(
          await t
            .update(ENC)
            .set({
              status: trans.to,
              signedAt: now,
              updatedAt: now,
              ...lateColumns,
              ...evvPersistence(evvAtSign),
              ...delivery,
            })
            .where(and(eq(ENC.id, encounterId), eq(ENC.status, r.status)))
            .returning({ id: ENC.id }),
          SIGN_LOST_RACE,
        );
        await t.insert(SIG).values({
          organizationId,
          ...siting,
          encounterId,
          kind: "primary",
          signedByMembershipId,
          signedByDiscipline: r.discipline,
          signedAt: now,
          method: provenance.method,
          sessionId: actor.sessionId,
          stepUpAuthAt: provenance.stepUpAuthAt,
          attestationText: PRIMARY_ATTESTATION_TEXT,
          layer2InvolvedAtSigning: false,
        });
        await emit(t, organizationId, "m8.encounter.signed", "encounter", encounterId, {
          encounterId,
          patientId: r.patientId,
          admissionId: r.admissionId,
          ...(r.visitId ? { visitId: r.visitId } : {}),
          encounterType: r.encounterType,
          discipline: r.discipline,
          signedByMembershipId,
          signedAt: now.toISOString(),
          lateEntryTier: late.tier,
          layer2Involved: false,
          evvBracketState,
          evvMissingReason: r.evvMissingReason,
          requiresCosign,
          careplanLinks,
          documentRenderPayload: { final: finalPayload, addenda: [] },
        });
        await emitOrphanIfUnlinked(t, organizationId, r, now);
        if (requiresCosign) {
          // §2.4 D3 — open the cosignature request already `routed` to the assigned RN case manager,
          // resolved above through M5's CareTeamProvider. It used to route to `signedByMembershipId` —
          // the LPN who just signed the note — so the 12h/24h/48h SLA chain escalated at the author and
          // the cosignature queue showed them their own note (#124). The machine has already refused the
          // sign if this is null, so the non-null assertion is the guard's postcondition, not a hope.
          const routedToMembershipId = cosignerMembershipId as string;
          const cr = firstOrThrow(
            await t
              .insert(COSIGN)
              .values({
                organizationId,
                encounterId,
                routedToMembershipId,
                status: "routed",
                routedAt: now,
              })
              .returning({ id: COSIGN.id }),
            "cosignature_request insert returned no row",
          );
          await emit(
            t,
            organizationId,
            "m8.encounter.cosignature_routed",
            "cosignature_request",
            cr.id,
            {
              encounterId,
              routedToMembershipId,
              signedAt: now.toISOString(),
            },
          );
          return {
            status: "cosign_pending",
            signedAt: now.toISOString(),
            cosignatureRequestId: cr.id,
          };
        }
        return { status: "signed", signedAt: now.toISOString(), cosignatureRequestId: null };
      });
    },

    // ── Late-entry tier overrides (§2.5 D4) ────────────────────────────────────────────────────────────
    // ── Legacy confirm (rows signed before migration 1510) ───────────────────────────────────────────────
    // Writes ONLY the three modality columns on an already-signed row: a deliberate carve-out of
    // `checkMutableForEdit` (the clinical note is untouched, so no addendum is warranted). The encounter
    // audit trigger records the write; the actor is the signing user so the audit row names who confirmed.
    async confirmVisitModality(organizationId, encounterId, actor, args) {
      return withOrgContext(db, { organizationId, userId: actor.userId ?? "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        // GAP-028 — defence in depth behind the route's `is_author` guard: only the author confirms.
        if (r.authoredByMembershipId !== actor.membershipId) {
          throw new ForbiddenError(
            "only the author of an encounter may confirm its visit modality",
          );
        }
        if (r.status !== "signed" && r.status !== "cosign_pending" && r.status !== "cosigned") {
          throw new EncounterStateError(
            "ILLEGAL_TRANSITION",
            "visit modality is confirmed at signing; this encounter is not signed",
          );
        }
        // A ONE-TIME confirmation of an UNCONFIRMED (legacy) visit. Without this an author could flip a
        // confirmed `telephonic` to `in_person` and unlock the SIA payment. A confirmed mode is final here.
        const alreadyConfirmed = (): EncounterStateError =>
          new EncounterStateError(
            "MODALITY_ALREADY_CONFIRMED",
            "the delivery mode of this visit is already confirmed and cannot be changed here",
          );
        if (r.visitModalityConfirmedAt !== null) throw alreadyConfirmed();
        assertModalityFitsVisitType(r.encounterType, args.visitModality);
        const confirmedAt = clock();
        const columns = confirmedModalityColumns(
          args.visitModality,
          actor.membershipId,
          confirmedAt,
        );
        // The loaded row above is a read, not a lock: the guard is repeated in the UPDATE so two concurrent
        // confirms cannot both win (the loser re-evaluates the predicate after the winner commits, matches
        // no row, and gets the same 409).
        const updated = await t
          .update(ENC)
          .set({ ...columns, updatedAt: confirmedAt })
          .where(and(eq(ENC.id, encounterId), isNull(ENC.visitModalityConfirmedAt)))
          .returning({ id: ENC.id });
        if (updated.length === 0) throw alreadyConfirmed();
        return {
          visitModality: columns.visitModality,
          visitModalityConfirmedAt: columns.visitModalityConfirmedAt.toISOString(),
        };
      });
    },

    async lateEntryOverride(organizationId, encounterId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        // GAP-013 — the tier is the SERVER's computation, so an override on an encounter that is not
        // actually in the significant tier (too early, or already administrative) is a 409. The route's
        // permission + step-up guards stand behind `isSupervisor` / `stepUpFresh` (GAP-014).
        const tier = computeLateEntryTier({
          serviceDate: r.serviceDate as LocalDate,
          asOfDate: await orgLocalToday(t, organizationId),
        });
        decideSignificantLateOverride({
          tier,
          isSupervisor: true,
          reason: args.reason,
          stepUpFresh: true,
        });
        const daysLate = lateDaysBetween(
          r.serviceDate as LocalDate,
          await orgLocalToday(t, organizationId),
        );
        await t
          .update(ENC)
          .set({
            lateEntryTier: "significant_late_entry",
            // keep the author's own reason when it is already good enough; the CHECK needs one >= 40.
            lateEntryReason: keepOrReplaceReason(r.lateEntryReason, args.reason),
            significantLateOverrideBy: args.actorMembershipId,
            significantLateOverrideReason: args.reason,
            updatedAt: new Date(),
          })
          .where(eq(ENC.id, encounterId));
        await emit(
          t,
          organizationId,
          "m8.encounter.late_entry_override",
          "encounter",
          encounterId,
          {
            encounterId,
            overrideBy: args.actorMembershipId,
            overrideReason: args.reason,
            daysLate,
          },
        );
        return { status: r.status };
      });
    },
    async administrativeOverride(organizationId, encounterId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        const asOfDate = await orgLocalToday(t, organizationId);
        const tier = computeLateEntryTier({ serviceDate: r.serviceDate as LocalDate, asOfDate });
        decideAdministrativeLateOverride({
          tier,
          isDirector: true,
          reason: args.reason,
          stepUpFresh: true,
        });
        const daysLate = lateDaysBetween(r.serviceDate as LocalDate, asOfDate);
        await t
          .update(ENC)
          .set({
            lateEntryTier: "administrative_override",
            lateEntryReason: keepOrReplaceReason(r.lateEntryReason, args.reason),
            administrativeOverrideBy: args.actorMembershipId,
            administrativeOverrideReason: args.reason,
            updatedAt: new Date(),
          })
          .where(eq(ENC.id, encounterId));
        await emit(
          t,
          organizationId,
          "m8.encounter.administrative_override",
          "encounter",
          encounterId,
          {
            encounterId,
            overrideBy: args.actorMembershipId,
            overrideReason: args.reason,
            daysLate,
          },
        );
        return { status: r.status };
      });
    },

    // ── Void (admin-only terminal state; reason >= 40) ─────────────────────────────────────────────────
    async voidEncounter(organizationId, encounterId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        const trans = transitionEncounter(r.status, {
          type: "void",
          isAdmin: args.isAdmin,
          reason: args.reason,
          at: args.at,
        });
        await t
          .update(ENC)
          .set({
            status: trans.to,
            // `encounter_vocab_pinned_when_finalized` requires a pinned vocab for any non-draft status;
            // a draft voided before it ever finalized has none. Pin the corpus current AT THE VOID — a
            // real, decodable release rather than the old sentinel. Nothing was ever assembled under it,
            // and a voided draft claims no narrative, but the column must say something and a truthful
            // "this is what the platform was shipping" beats a uuid that names nothing (#128).
            vocabVersionId: r.vocabVersionId ?? activeVocabPin().id,
            voidedAt: new Date(),
            voidedBy: args.actorMembershipId, // CW-CL-10: the voiding admin, never the original author
            voidedReason: args.reason,
            updatedAt: new Date(),
          })
          .where(eq(ENC.id, encounterId));
        await emit(t, organizationId, "m8.encounter.voided", "encounter", encounterId, {
          encounterId,
          voidedBy: args.actorMembershipId,
          voidedReason: args.reason,
        });
        return { status: "voided" };
      });
    },

    // ── Cosignature-request chain (§2.4 D3) ────────────────────────────────────────────────────────────
    // One workflow, two subjects (the note's own request, or an amending addendum's): ./cosignature/db-cosignature.ts.
    async cosignAcknowledge(organizationId, encounterId, actor, at, addendumId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
        acknowledgeCosignature(
          tx as unknown as DbClient,
          cosignSubjectOf(encounterId, addendumId),
          actor,
          at,
        ),
      );
    },
    async cosignSign(organizationId, encounterId, actor, args) {
      return withOrgContext(db, { organizationId, userId: actor.userId ?? "" }, async (tx) =>
        signCosignature(
          tx as unknown as DbClient,
          cosignatureDeps,
          organizationId,
          cosignSubjectOf(encounterId, args.addendumId),
          actor,
          args,
        ),
      );
    },
    async supervisorRelease(organizationId, encounterId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
        releaseCosignature(
          tx as unknown as DbClient,
          cosignSubjectOf(encounterId, args.addendumId),
          args,
        ),
      );
    },

    // ── Addendum aggregate (§2.3 — draft → finalize → sign) ────────────────────────────────────────────
    async createAddendum(organizationId, encounterId, args) {
      try {
        return await createAddendumTx(organizationId, encounterId, args);
      } catch (err) {
        // A second live draft for the same proposal (409) or a proposal that moved under us (422); anything else rethrows.
        if (args.promotion) mapPromotionInsertError(err);
        throw err;
      }
    },
    async listChartPromotions(organizationId, encounterId, reviewerUserId) {
      const patientId = await patientOfEncounter(organizationId, encounterId);
      return listForPatient(organizationId, patientId, reviewerUserId);
    },
    async rejectChartPromotion(organizationId, encounterId, requestId, args) {
      const patientId = await patientOfEncounter(organizationId, encounterId);
      // The seam reads in its own tenant context, so resolve it BEFORE opening the write transaction.
      await requireReview(organizationId, requestId, args.reviewerUserId, patientId);
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // A reviewer who already has a (non-voided) addendum from this proposal is mid-decision: rejecting it now would
        // leave a signed, attributed record against a request that says rejected. They void the draft first.
        const [draft] = await (tx as unknown as DbClient)
          .select({ id: ADDENDUM.id })
          .from(ADDENDUM)
          .where(and(eq(ADDENDUM.promotionRequestId, requestId), ne(ADDENDUM.status, "voided")))
          .limit(1);
        if (draft) throw promotionHasDraft();
        await emit(
          tx,
          organizationId,
          CHART_PROMOTION_DECIDED_EVENT,
          "encounter",
          encounterId,
          decidedPayload({
            organizationId,
            promotionRequestId: requestId,
            outcome: "rejected",
            resultRef: null,
            decidedByUserId: args.reviewerUserId,
            reasonCode: args.reasonCode,
            at: clock(),
          }),
        );
      });
      return { promotionRequestId: requestId, outcome: "rejected" };
    },
    async updateAddendumSelections(organizationId, encounterId, addendumId, input) {
      const { stored, prose } = splitFreeText(input.sections);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const a = await loadAddendum(t, encounterId, addendumId);
        // The addendum inherits its parent's template — an addendum to an RN routine visit is written
        // against the RN routine-visit template, not one of its own.
        const parent = await loadEnc(t, encounterId);
        const layer1Preview = assembleSelections(
          parent.encounterType,
          parent.discipline,
          parent.serviceDate,
          input.sections,
        );
        const freeTextCipherValue = await sealProse(organizationId, prose);
        const updated = firstOrThrow(
          await t
            .update(ADDENDUM)
            .set({
              version: Number(a.version) + 1,
              updatedAt: new Date(),
            })
            .where(eq(ADDENDUM.id, addendumId))
            .returning({ version: ADDENDUM.version }),
          "addendum update matched no row",
        );
        await t
          .insert(SEL)
          .values({
            organizationId,
            providerEntityId: a.providerEntityId,
            locationId: a.locationId,
            addendumId,
            templateKey: hearthnoteTemplateKey(parent.encounterType, parent.discipline),
            templateVersion: VOCAB_VERSION,
            selections: { sections: stored },
            freeTextCipher: freeTextCipherValue,
          })
          .onConflictDoUpdate({
            target: SEL.addendumId,
            targetWhere: isNotNull(SEL.addendumId),
            set: {
              selections: { sections: stored },
              freeTextCipher: freeTextCipherValue,
              updatedAt: new Date(),
              version: sql`${SEL.version} + 1`,
            },
          });
        return { version: Number(updated.version), layer1Preview };
      });
    },

    async getAddendumSelections(organizationId, encounterId, addendumId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadAddendum(t, encounterId, addendumId);
        const parent = await loadEnc(t, encounterId);
        const [row] = await t.select().from(SEL).where(eq(SEL.addendumId, addendumId)).limit(1);
        const sections = row ? await openProse(organizationId, row) : [];
        return {
          templateKey: hearthnoteTemplateKey(parent.encounterType, parent.discipline),
          vocabVersion: VOCAB_VERSION,
          sections,
          layer1Preview: assembleSelections(
            parent.encounterType,
            parent.discipline,
            parent.serviceDate,
            sections,
          ),
          version: row ? Number(row.version) : 0,
        };
      });
    },
    async finalizeAddendum(organizationId, encounterId, addendumId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const a = await loadAddendum(t, encounterId, addendumId);
        const trans = transitionAddendum(a.status as "draft" | "finalized" | "signed", {
          type: "finalize",
          gatePreviewPassed: await gateAddendum(t, addendumId, "finalize"),
          at: new Date().toISOString().slice(0, 10) as LocalDate,
        });
        await t
          .update(ADDENDUM)
          .set({ status: trans.to, updatedAt: new Date() })
          .where(eq(ADDENDUM.id, addendumId));
        // The addendum's own assembled output (`addendum_finalize`), pinned the same way and against the
        // PARENT's template and pinned vocab version — an addendum to an RN routine visit is written
        // against the RN routine-visit template, so it must be pinned against it too.
        const parent = await loadEnc(t, encounterId);
        await pinAssembledOutput(t, organizationId, {
          kind: "addendum_finalize",
          encounterId: null,
          addendumId,
          providerEntityId: a.providerEntityId,
          locationId: a.locationId,
          encounterType: parent.encounterType,
          discipline: parent.discipline,
          serviceDate: parent.serviceDate,
          // The parent is finalized or later, and `encounter_vocab_pinned_when_finalized` makes a pin
          // NOT NULL for every non-draft row — so this is the parent's real pin. There is deliberately
          // no fallback: an addendum inherits the vocabulary its parent was signed under, and if that
          // is somehow absent the honest move is to refuse, not to mint a second answer (#128).
          vocabVersionId: requireParentVocabPin(parent.vocabVersionId, encounterId),
        });
        return { status: "finalized" };
      });
    },
    async signAddendum(organizationId, encounterId, addendumId, actor, args) {
      // The real signer is the audit actor (the amendment rows and resolutions it writes are attributed to them), as a primary sign does.
      return withOrgContext(db, { organizationId, userId: actor.userId ?? "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // Locked first, as sign and finalize do (ADR-0114 VN-D30): the amendments are decided from a draft read after every section resolution
        // that held the row has committed, and a second sign of the same addendum waits here, then finds it signed (409 ILLEGAL_TRANSITION).
        const enc = await loadEnc(t, encounterId, { lock: true });
        const a = await loadAddendum(t, encounterId, addendumId);
        const now = new Date();
        const provenance = await resolveSignatureProvenance(organizationId, actor.sessionId);
        if (!enc.providerEntityId || !enc.locationId) {
          throw new EncounterStateError(
            "ILLEGAL_TRANSITION",
            "encounter must be sited (provider entity + location) before an addendum can be signed",
          );
        }
        if (a.status === "voided") {
          throw new EncounterStateError("ILLEGAL_TRANSITION", "a voided addendum cannot be signed");
        }
        if (a.promotionRequestId && !actor.userId) throw new UnauthorizedError();
        // Before the draft is read: an addendum another request has already signed is a 409 here, not a refusal from deep inside the amendments.
        if (!ADDENDUM_GRAPH[a.status as AddendumState]?.includes("sign")) {
          throw new EncounterStateError(
            "ILLEGAL_TRANSITION",
            `addendum cannot sign from '${a.status}'`,
          );
        }
        const addendum = {
          id: a.id,
          organizationId,
          encounterId,
          providerEntityId: enc.providerEntityId,
          locationId: enc.locationId,
        };
        // ADR-0114 VN-D30: the SIGNER's draft of the note as of the visit time, every section the addendum names resolved or the sign is refused
        // (409 DRAFT_SECTION_STALE); `null` for an addendum that names nothing, which signs as it always did.
        const amending = await amendments.prepare(t, enc, addendumId, {
          roles: actor.roles ?? [],
          membershipId: actor.membershipId,
        });
        const amendedSections = amending?.sections ?? [];
        const trans = transitionAddendum(a.status as AddendumState, {
          type: "sign",
          gatePassed: await gateAddendum(t, addendumId, "sign"),
          stepUpFresh: provenance.stepUpFresh,
          at: args.at,
        });
        // An amendment of a note that needed a cosigner needs one too (its own request and clock; the note's own are untouched).
        const cosignerMembershipId =
          amendedSections.length > 0
            ? await cosignerForAmendment(t, organizationId, enc, actor.membershipId)
            : null;
        // The sealed amendment rows go in BEFORE the status flips: the guard trigger takes rows only for a `finalized` addendum. Any failure
        // (a seal, the key ring, the guard) fails the sign as one.
        if (amending !== null) await amendments.write(t, addendum, amending);
        firstOrThrow(
          await t
            .update(ADDENDUM)
            .set({ status: trans.to, signedAt: now, updatedAt: now })
            .where(and(eq(ADDENDUM.id, addendumId), eq(ADDENDUM.status, a.status)))
            .returning({ id: ADDENDUM.id }),
          "addendum sign matched no row: the addendum changed status since it was loaded",
        );
        await t.insert(SIG).values({
          organizationId,
          providerEntityId: enc.providerEntityId,
          locationId: enc.locationId,
          encounterId,
          addendumId,
          kind: "addendum",
          signedByMembershipId: actor.membershipId,
          signedByDiscipline: enc.discipline,
          signedAt: now,
          method: provenance.method,
          sessionId: actor.sessionId,
          stepUpAuthAt: provenance.stepUpAuthAt,
          attestationText: ADDENDUM_ATTESTATION_TEXT,
          layer2InvolvedAtSigning: false,
        });
        await emit(t, organizationId, "m8.encounter.addendum_signed", "encounter", encounterId, {
          encounterId,
          addendumId,
          signedByMembershipId: actor.membershipId,
          signedAt: now.toISOString(),
          reason: a.reason,
          // F-168 (#248) — the same PHI-safe stand-in `.signed` sends (`final: ""`; the pinned narrative
          // never leaves the outbox in the clear). M22 appends a new `document_version` on the SAME
          // `encounterId` from this.
          documentRenderPayload: {
            final: "",
            addenda: [{ addendumId, reason: a.reason, text: "" }],
          },
        });
        // ADR-0114 VN-D30: one explicit event per amended section (ids and a flag only, never text, a hash or a source id).
        for (const section of amendedSections) {
          await emit(t, organizationId, "m8.encounter.section_amended", "encounter", encounterId, {
            encounterId,
            addendumId,
            sectionId: section.sectionId,
            part2Derived: section.part2Derived,
          });
        }
        const cosignatureRequestId =
          cosignerMembershipId === null
            ? null
            : await openAddendumCosignature(t, addendum, cosignerMembershipId, now);
        // WP 3.7: the reviewer signed an addendum authored from a proposal. Same transaction as the signature, so the
        // proposal is accepted if and only if the signed record exists (a voided or unsigned addendum never gets here).
        if (a.promotionRequestId && actor.userId) {
          await emit(
            t,
            organizationId,
            CHART_PROMOTION_DECIDED_EVENT,
            "encounter_addendum",
            addendumId,
            decidedPayload({
              organizationId,
              promotionRequestId: a.promotionRequestId,
              outcome: "accepted",
              resultRef: addendumId,
              decidedByUserId: actor.userId,
              reasonCode: null,
              at: now,
            }),
          );
        }
        return {
          status: "signed" as const,
          signedAt: now.toISOString(),
          ...(amending === null
            ? {}
            : { amendedSectionIds: amendedSections.map((s) => s.sectionId), cosignatureRequestId }),
        };
        // The database proves the proposal is still open at the moment of signing (rejected, accepted or gone = 422).
      }).catch(mapPromotionInsertError);
    },
  };
}

/**
 * The production, RLS-backed EncounterAbacResolver — M8's §4.6 `cosigner_role_match` predicate loads the
 * encounter's author + discipline facts through it. The load is a single org-scoped read under
 * `withOrgContext` (RLS backstops), returning `null` when the row is absent/cross-tenant so the predicate
 * fails closed (no self-cosign is decided against the real `authored_by_membership_id`).
 */
export function createDbEncounterAbacResolver(db: DbClient): EncounterAbacResolver {
  return {
    async loadEncounter(organizationId, encounterId): Promise<EncounterAbacFacts | null> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            id: ENC.id,
            patientId: ENC.patientId,
            discipline: ENC.discipline,
            authoredByMembershipId: ENC.authoredByMembershipId,
          })
          .from(ENC)
          .where(eq(ENC.id, encounterId))
          .limit(1);
        return r
          ? {
              encounterId: r.id,
              patientId: r.patientId,
              discipline: r.discipline as EncounterAbacFacts["discipline"],
              authoredByUserId: r.authoredByMembershipId,
            }
          : null;
      });
    },
    async loadAddendumAuthor(organizationId, encounterId, addendumId): Promise<string | null> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ authoredByMembershipId: ADDENDUM.authoredByMembershipId })
          .from(ADDENDUM)
          .where(and(eq(ADDENDUM.id, addendumId), eq(ADDENDUM.encounterId, encounterId)))
          .limit(1);
        return r?.authoredByMembershipId ?? null;
      });
    },
  };
}
