// @wardenx/idg — §2.4 D1 / §2.5 D7 packet-snapshot builder (M14-T04, BASIC). Pure.
//
// The "since last IDG" view is a packet-build-time JOIN across the upstream seam reads (§1.1) — M14 never
// duplicates clinical data. This module is the IO-free assembler the M14-T05 build worker composes AFTER it
// has read the seams (M5 `PatientReader`, M6 recert/F2F reader, M7 `CarePlanReader`, M8 `SignedEncountersReader`,
// M9/M10 summaries, M11 `OrderProvider.getOrdersSince`, M12 `MedicationOrderProvider.getMedicationsSince`):
// it filters each since-block to the resolved cursor, assembles the typed `PacketSnapshot` (the survey
// artifact frozen on adjournment) and the per-discipline `DisciplineViewBlock` map (§2.5 D7), and derives the
// cover-level discussion flags deterministically (Layer 1 — the Layer 2 narrative polish is the M14-T05
// `ai-platform` call, gated per D6; BASIC build leaves `layer2Polished: null`).
//
// PURE DATA — no IO, `@wardenx/types` + the local `@wardenx/idg` policy only. The seam reads, the SUD
// `consent.evaluate` gate (W-SUD-01, see `sud-redactor.ts`), and the idempotent upsert are the service's job.
import type {
  AdmissionId,
  DisciplineKey,
  DisciplineViewBlock,
  IdgLevelOfCare,
  IdgMeetingId,
  IsoInstant,
  LocationId,
  PacketActionItemCarryForwardDigest,
  PacketAssessmentChangeDigest,
  PacketDiscussionFlag,
  PacketEncounterDigest,
  PacketFlaggedEventDigest,
  PacketHopeTriggerDigest,
  PacketMedicationChangeDigest,
  PacketOrderChangeDigest,
  PacketSnapshot,
  PatientId,
} from "@wardenx/types";
import { DISCIPLINE_VIEW_POLICY } from "../policy";
import { resolveSinceCursor } from "./freeze";

/** The §2.4 schema-version string the v1 packet shape carries (M22 renderer negotiation). */
export const PACKET_SCHEMA_VERSION = "2026-01-v1" as const;

/** The §3.30 (next-recert) window in days within which `recert_due` surfaces on the cover. */
export const RECERT_FLAG_WINDOW_DAYS = 30 as const;

/** The meeting/patient/admission identity + the §1.1 cursor anchors the service resolves from the seams. */
export interface PacketBuildContext {
  readonly meetingId: IdgMeetingId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly locationId: LocationId;
  readonly builtAt: IsoInstant;
  readonly builderJobId: string;
  /** The prior IDG's `adjourned_at` for THIS patient (`IdgScheduleProvider` join) — `null` ⇒ first IDG. */
  readonly priorIdgAdjournedAt: IsoInstant | null;
  /** The admission `activated_at` (M6 reader) — the `first_idg` cursor + the `daysOnService` anchor. */
  readonly admissionActivatedAt: IsoInstant;
}

/** The cover facts read from M5 `PatientReader` + M6 recert/F2F reader + M7/M39 (raw, pre-redaction). */
export interface PacketCoverInput {
  readonly firstName: string;
  readonly lastInitial: string; // M5 D3 display rule renders "First L."
  readonly age: number;
  readonly primaryDiagnosisIcd10: string;
  readonly primaryDiagnosisLabel: string; // resolved via M38
  readonly levelOfCare: IdgLevelOfCare;
  readonly nextRecertDueAt: IsoInstant | null; // M6 reader
  readonly f2fWindowState: "not_due" | "window_open" | "overdue" | null;
  readonly activeDpoa: { readonly agentName: string; readonly consentId: string } | null;
  readonly activeSudFlag: boolean; // governs the cover banner; content filtering is the read-path redactor
}

/** The raw "since last IDG" seam digests, PRE-cursor-filter (the builder applies the `> cursor` filter). */
export interface SinceLastIdgInput {
  readonly encounters: readonly PacketEncounterDigest[]; // M8 SignedEncountersReader
  readonly significantAssessmentChanges: readonly PacketAssessmentChangeDigest[]; // M9 subscription
  readonly j2051Triggers: readonly PacketHopeTriggerDigest[]; // M10 subscription
  readonly ordersChanged: readonly PacketOrderChangeDigest[]; // M11 OrderProvider.getOrdersSince
  readonly medicationsChanged: readonly PacketMedicationChangeDigest[]; // M12 MedicationOrderProvider
  readonly flaggedEvents: readonly PacketFlaggedEventDigest[]; // derived (hospitalisation/ER/fall/…)
}

/** The M7 `CarePlanReader` active-plan summary (already projected to the packet cover shape). */
export interface CarePlanSummaryInput {
  readonly activeProblemCount: number;
  readonly activeGoalCount: number;
  readonly activeInterventionCount: number;
  readonly lastSignedVersionId: string;
  readonly lastSignedAt: IsoInstant;
  readonly nextReviewDueAt: IsoInstant;
  readonly isReviewOverdue: boolean;
}

/** The M9/M10 HOPE summary — `null` when the patient has no HOPE context (non-Medicare or pre-HOPE). */
export interface HopeContextInput {
  readonly upcomingTimepoints: ReadonlyArray<{
    readonly timepoint: string;
    readonly dueAt: IsoInstant;
  }>;
  readonly openSfvCount: number;
}

/** The full pure-input bundle for one `(meeting, patient)` packet build. */
export interface PacketBuildInput {
  readonly context: PacketBuildContext;
  readonly cover: PacketCoverInput;
  readonly sinceLastIdg: SinceLastIdgInput;
  readonly carePlanSummary: CarePlanSummaryInput;
  readonly hopeContext: HopeContextInput | null;
  readonly carryForwardActionItems: readonly PacketActionItemCarryForwardDigest[];
}

/** The build product: the survey snapshot (`built_snapshot`) + the per-discipline view map (`discipline_views`). */
export interface BuiltPacket {
  readonly snapshot: PacketSnapshot;
  readonly disciplineViews: Record<DisciplineKey, DisciplineViewBlock>;
}

/** Whole days between two ISO instants (floor), used for `daysOnService` + the recert-window flag. */
function daysBetween(fromIso: IsoInstant, toIso: IsoInstant): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Math.floor(ms / 86_400_000);
}

/** Keep only digests whose timestamp is strictly after the cursor (the §1.1 "since" filter). */
function after<T>(items: readonly T[], cursorIso: IsoInstant, at: (item: T) => IsoInstant): T[] {
  const cursor = new Date(cursorIso).getTime();
  return items.filter((item) => new Date(at(item)).getTime() > cursor);
}

/** One flat highlight candidate, tagged with its `sourceKind` so each discipline view filters by emphasis. */
type Highlight = DisciplineViewBlock["highlightedEntries"][number];

/** Project the filtered since-blocks + carry-forward items into the flat highlight list (Layer 1, §2.5). */
function buildHighlights(
  since: SinceLastIdgInput,
  carryForward: readonly PacketActionItemCarryForwardDigest[],
): Highlight[] {
  return [
    ...since.encounters.map(
      (e): Highlight => ({
        sourceKind: "encounter",
        sourceId: e.encounterId,
        label: e.encounterType,
        summary: `${e.authorDiscipline} encounter signed ${e.signedAt}`,
        severity: "info",
      }),
    ),
    ...since.significantAssessmentChanges.map(
      (a): Highlight => ({
        sourceKind: "assessment",
        sourceId: a.assessmentId,
        label: a.scaleKind,
        summary: `${a.changeKind} change on ${a.scaleKind}`,
        severity: "attention",
      }),
    ),
    ...since.j2051Triggers.map(
      (h): Highlight => ({
        sourceKind: "hope",
        sourceId: h.hopeAssessmentId,
        label: h.triggerKind,
        summary: `HOPE ${h.triggerKind} fired ${h.firedAt}`,
        severity: "attention",
      }),
    ),
    ...since.ordersChanged.map(
      (o): Highlight => ({
        sourceKind: "order",
        sourceId: o.orderId,
        label: o.orderKind,
        summary: `${o.changeKind} (${o.orderKind})`,
        severity: "info",
      }),
    ),
    ...since.medicationsChanged.map(
      (m): Highlight => ({
        sourceKind: "medication",
        sourceId: m.medicationOrderId,
        label: m.drugLabel,
        summary: `${m.changeKind}: ${m.drugLabel}`,
        severity: "info",
      }),
    ),
    ...since.flaggedEvents.map(
      (f): Highlight => ({
        sourceKind: "flag",
        sourceId: f.sourceId,
        label: f.kind,
        summary: `${f.kind} occurred ${f.occurredAt}`,
        severity: f.severity,
      }),
    ),
    ...carryForward.map(
      (c): Highlight => ({
        sourceKind: "action_item",
        sourceId: c.actionItemId,
        label: "carry-forward action item",
        summary: `overdue ${c.dueDate} (carried ${c.carryForwardCount}×)`,
        severity: c.carryForwardCount >= 3 ? "urgent" : "attention",
      }),
    ),
  ];
}

/** Derive the §2.4 per-discipline view map: the same highlight list, filtered per `DISCIPLINE_VIEW_POLICY`. */
function deriveDisciplineViews(
  highlights: readonly Highlight[],
  sinceContext: "prior_idg" | "first_idg",
): Record<DisciplineKey, DisciplineViewBlock> {
  const keys = Object.keys(DISCIPLINE_VIEW_POLICY) as DisciplineKey[];
  const out = {} as Record<DisciplineKey, DisciplineViewBlock>;
  for (const discipline of keys) {
    const emphasis = DISCIPLINE_VIEW_POLICY[discipline];
    const highlightedEntries = highlights.filter((h) => emphasis.includes(h.sourceKind));
    out[discipline] = {
      oneLineSummary: `${highlightedEntries.length} highlighted item(s) for ${discipline} since ${
        sinceContext === "prior_idg" ? "the last IDG" : "admission"
      }`,
      highlightedEntries,
      openQuestions: [],
      layer2Polished: null, // BASIC build — Layer 2 polish is the gated M14-T05 ai-platform call (D6)
    };
  }
  return out;
}

/** Derive the deterministic (Layer 1) cover discussion flags from the cover + since-blocks (§2.4). */
function deriveDiscussionFlags(
  cover: PacketCoverInput,
  since: SinceLastIdgInput,
  builtAt: IsoInstant,
): PacketDiscussionFlag[] {
  const flags: PacketDiscussionFlag[] = [];
  const recertDueSoon =
    cover.f2fWindowState === "overdue" ||
    cover.f2fWindowState === "window_open" ||
    (cover.nextRecertDueAt !== null &&
      daysBetween(builtAt, cover.nextRecertDueAt) <= RECERT_FLAG_WINDOW_DAYS);
  if (recertDueSoon) {
    flags.push({
      kind: "recert_due",
      detail: `recert/F2F window: ${cover.f2fWindowState ?? "within 30 days"}`,
    });
  }
  // One `level_of_care_candidate` flag however many triggers fired (a second flag of the same kind would
  // render twice on the cover). F-218 added the GIP-proposal trigger: an after-hours triage call that
  // indicated a care-plan change (M19 `care_plan_change_indicated`, pulled as a flagged event).
  const locTriggers: string[] = [];
  if (since.flaggedEvents.some((f) => f.kind === "hospitalisation" || f.kind === "er_visit")) {
    locTriggers.push("hospitalisation / ER event since last IDG");
  }
  if (since.flaggedEvents.some((f) => f.kind === "triage_care_plan_change")) {
    locTriggers.push("after-hours triage call proposed a GIP admission since last IDG");
  }
  if (locTriggers.length > 0) {
    flags.push({ kind: "level_of_care_candidate", detail: locTriggers.join("; ") });
  }
  if (since.significantAssessmentChanges.length > 0 || since.j2051Triggers.length > 0) {
    flags.push({
      kind: "complex_symptoms",
      detail: "significant assessment change or HOPE symptom-impact trigger",
    });
  }
  if (cover.activeSudFlag) {
    flags.push({
      kind: "sud_pattern_review",
      detail: "active SUD-flagged content — 42 CFR Part 2 applies",
    });
  }
  return flags;
}

/**
 * Build the §2.4 D1 `PacketSnapshot` + the §2.5 D7 discipline-view map for one `(meeting, patient)` (BASIC).
 * Pure assembly over already-read seam digests: resolve the §1.1 cursor, filter each since-block strictly
 * after it, project the flat highlight list, derive the per-discipline views + the Layer 1 discussion flags,
 * and stamp the cover. `appliedSudRedaction` is `false` here — the build produces the FULL snapshot; the
 * read-path `applySudRedaction` (W-SUD-01) elides SUD blocks per the caller's 42 CFR Part 2 release. `capProjection`
 * is `null` (the M26 cap deny-stub ships in a later wave). The service freezes + upserts the result.
 */
export function buildPacketSnapshot(input: PacketBuildInput): BuiltPacket {
  const { context, cover, sinceLastIdg, carePlanSummary, hopeContext, carryForwardActionItems } =
    input;
  const { sinceCursorIso, sinceContext } = resolveSinceCursor(
    context.priorIdgAdjournedAt,
    context.admissionActivatedAt,
  );

  const sinceLastIdgFiltered: PacketSnapshot["sinceLastIdg"] = {
    encounters: after(sinceLastIdg.encounters, sinceCursorIso, (e) => e.signedAt),
    significantAssessmentChanges: after(
      sinceLastIdg.significantAssessmentChanges,
      sinceCursorIso,
      (a) => a.occurredAt,
    ),
    j2051Triggers: after(sinceLastIdg.j2051Triggers, sinceCursorIso, (h) => h.firedAt),
    ordersChanged: after(sinceLastIdg.ordersChanged, sinceCursorIso, (o) => o.changedAt),
    medicationsChanged: after(sinceLastIdg.medicationsChanged, sinceCursorIso, (m) => m.changedAt),
    flaggedEvents: after(sinceLastIdg.flaggedEvents, sinceCursorIso, (f) => f.occurredAt),
  };

  const highlights = buildHighlights(sinceLastIdgFiltered, carryForwardActionItems);

  const snapshot: PacketSnapshot = {
    schemaVersion: PACKET_SCHEMA_VERSION,
    meta: {
      meetingId: context.meetingId,
      patientId: context.patientId,
      admissionId: context.admissionId,
      locationId: context.locationId,
      builtAt: context.builtAt,
      sinceCursorIso,
      sinceContext,
      builderJobId: context.builderJobId,
      appliedSudRedaction: false,
    },
    patientCover: {
      fullNameRedacted: `${cover.firstName} ${cover.lastInitial}.`,
      age: cover.age,
      primaryDiagnosisIcd10: cover.primaryDiagnosisIcd10,
      primaryDiagnosisLabel: cover.primaryDiagnosisLabel,
      daysOnService: daysBetween(context.admissionActivatedAt, context.builtAt),
      levelOfCare: cover.levelOfCare,
      nextRecertDueAt: cover.nextRecertDueAt,
      f2fWindowState: cover.f2fWindowState,
      activeDpoa: cover.activeDpoa,
      activeSudFlag: cover.activeSudFlag,
    },
    sinceLastIdg: sinceLastIdgFiltered,
    carePlanSummary,
    hopeContext,
    capProjection: null,
    carryForwardActionItems,
    flagsForDiscussion: deriveDiscussionFlags(cover, sinceLastIdgFiltered, context.builtAt),
  };

  return { snapshot, disciplineViews: deriveDisciplineViews(highlights, sinceContext) };
}
