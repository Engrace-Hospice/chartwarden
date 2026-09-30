// apps/backend/src/modules/14-idg/routes/packet-content.ts — the PACKET CONTENT read model (§2.4 D1 / §2.5 D7 /
// UI "Patient Packet (center)"): the frozen `built_snapshot` + `discipline_views` shaped for the packet page and
// the live-meeting centre pane.
//
// PURE — no IO. It maps ONLY what the build snapshot holds; nothing is fetched, recomputed, or guessed. A section
// the builder legitimately left empty (or never captured: `hopeContext` is `null`, `flaggedEvents` is `[]`, …)
// is empty/`null` here, never back-filled. The cover summary is DETERMINISTIC Layer-1 text composed from the
// snapshot's own facts (no LLM; `layer2Polished` is never read — the D6 polish is a gated, separate concern).
//
// SUD (42 CFR Part 2, W-SUD-01): redaction is `@wardenx/idg`'s `applySudRedaction`, applied HERE before the
// view is shaped (so the cover summary and counts describe what the caller is actually shown, never what was
// elided). The build snapshot carries no per-source SUD tag — only the patient-level `patientCover.activeSudFlag`
// — so a caller WITHOUT a Part 2 release on a SUD-flagged patient gets EVERY source-derived block elided
// (fail-closed: we cannot tell which encounter/assessment/order is the SUD one, so none is shown). The banner
// signal (`appliedSudRedaction` + notice) is non-PHI. Counts of withheld rows are never published.
import { DISCIPLINE_VIEW_POLICY, applySudRedaction } from "@wardenx/idg";
import type { DisciplineKey, DisciplineViewBlock, PacketSnapshot } from "@wardenx/types";

/** The only snapshot schema this mapper understands. Anything else ⇒ `content: null` (fail-honest). */
export const SUPPORTED_PACKET_SCHEMA_VERSION = "2026-01-v1" as const;

/** The non-PHI banner shown when W-SUD-01 elided content for this caller. */
export const SUD_REDACTION_NOTICE = "Some content filtered per 42 CFR Part 2" as const;

export type PacketLevelOfCare =
  | "routine"
  | "continuous"
  | "inpatient_respite"
  | "general_inpatient";

export interface PacketContentDisciplineItem {
  readonly sourceKind:
    | "encounter"
    | "assessment"
    | "order"
    | "medication"
    | "hope"
    | "action_item"
    | "flag";
  readonly sourceId: string;
  readonly label: string;
  readonly summary: string;
  readonly severity: "info" | "attention" | "urgent" | null;
}

export interface PacketContentDiscipline {
  readonly discipline: DisciplineKey;
  /** Layer-1 deterministic one-liner from the build (`DisciplineViewBlock.oneLineSummary`) — re-derived from the
   * (possibly redacted) items so a redacted view never advertises elided entries. */
  readonly oneLineSummary: string;
  readonly items: readonly PacketContentDisciplineItem[];
  readonly openQuestions: readonly string[];
}

export interface PacketContentCounts {
  readonly signedEncounters: number;
  readonly assessmentChanges: number;
  readonly hopeTriggers: number;
  readonly orderChanges: number;
  readonly medicationChanges: number;
  readonly flaggedEvents: number;
  readonly carryForwardActionItems: number;
}

export interface PacketContentView {
  readonly schemaVersion: typeof SUPPORTED_PACKET_SCHEMA_VERSION;
  readonly cover: {
    /** Deterministic Layer-1 cover text composed from the facts below (no AI polish). */
    readonly summary: string;
    readonly builtAt: string;
    /** The "since last IDG" cursor (prior IDG `adjourned_at`, else admission activation). */
    readonly sinceCursorAt: string;
    readonly sinceContext: "prior_idg" | "first_idg";
    /** "First L." as frozen at build — minimum-necessary; the live display label rides the top-level `patient`. */
    readonly nameAtBuild: string;
    readonly age: number;
    readonly primaryDiagnosisIcd10: string;
    readonly primaryDiagnosisLabel: string;
    readonly levelOfCare: PacketLevelOfCare;
    readonly daysOnService: number;
    /** A DPOA is on file (the agent's name is deliberately not published on this read). */
    readonly hasActiveDpoa: boolean;
    /** Non-PHI banner signal — the patient carries an active SUD flag (never the protected content itself). */
    readonly activeSudFlag: boolean;
    /** M6 recert/F2F cover facts as snapshotted at build; `null` = the build could not resolve it. */
    readonly recert: {
      readonly nextRecertDueAt: string | null;
      readonly f2fWindowState: "not_due" | "window_open" | "overdue" | null;
    };
    readonly carePlan: {
      readonly activeProblemCount: number;
      readonly activeGoalCount: number;
      readonly activeInterventionCount: number;
      readonly lastSignedAt: string;
      readonly nextReviewDueAt: string;
      readonly isReviewOverdue: boolean;
    };
    readonly discussionFlags: ReadonlyArray<{ readonly kind: string; readonly detail: string }>;
    readonly counts: PacketContentCounts;
  };
  /** One entry per discipline view, in `DISCIPLINE_VIEW_POLICY` order (rn, msw, chaplain, aide, md_np, …). */
  readonly disciplines: readonly PacketContentDiscipline[];
  readonly signedEncounters: ReadonlyArray<{
    readonly encounterId: string;
    readonly encounterType: string;
    readonly discipline: string;
    readonly signedAt: string;
  }>;
  readonly assessmentChanges: ReadonlyArray<{
    readonly assessmentId: string;
    readonly scaleKind: string;
    readonly changeKind: string;
    readonly occurredAt: string;
  }>;
  readonly hopeTimepoints: {
    /** `false` ⇒ the build captured no HOPE context (`hopeContext` null) — "not captured", not "none due". */
    readonly captured: boolean;
    readonly upcoming: ReadonlyArray<{ readonly timepoint: string; readonly dueAt: string }>;
    readonly openSfvCount: number | null;
    readonly symptomImpactTriggers: ReadonlyArray<{
      readonly hopeAssessmentId: string;
      readonly triggerKind: string;
      readonly firedAt: string;
    }>;
  };
  /**
   * F-230 — the M12 external (DoseSpot/Surescripts MedHx) medication-history STATE, shown explicitly (M12 §5.5).
   * `captured: false` ⇒ the build did not capture it (seam unbound/failed, or a packet frozen before F-230) —
   * NOT "no history". `state: "not_pulled"` ⇒ no pull was ever ingested (e.g. DoseSpot not enabled) — also not
   * "no history". Only `none_available` (a pull ran and returned zero entries) carries the bedside-collection
   * message. `recordCount` is withheld (null) under W-SUD-01 (it can include SUD-treatment fills).
   */
  readonly externalMedicationHistory: {
    readonly captured: boolean;
    readonly state: "not_pulled" | "none_available" | "available" | null;
    readonly recordCount: number | null;
    readonly lastPulledAt: string | null;
    readonly message: string | null;
  };
  readonly orderChanges: ReadonlyArray<{
    readonly orderId: string;
    readonly orderKind: string;
    readonly changeKind: string;
    readonly changedAt: string;
  }>;
  readonly medicationChanges: ReadonlyArray<{
    readonly medicationOrderId: string;
    readonly drugLabel: string;
    readonly changeKind: string;
    readonly changedAt: string;
  }>;
  readonly flaggedEvents: ReadonlyArray<{
    readonly kind: string;
    readonly sourceId: string;
    readonly occurredAt: string;
    readonly severity: "info" | "attention" | "urgent";
  }>;
  readonly carryForwardActionItems: ReadonlyArray<{
    readonly actionItemId: string;
    readonly assignedToMembershipId: string;
    readonly dueDate: string;
    readonly carryForwardCount: number;
  }>;
}

/** What the mapper needs from the `idg_patient_packet` row (jsonb columns arrive as `unknown`). */
export interface PacketContentSource {
  readonly builtSnapshot: unknown;
  readonly disciplineViews: unknown;
}

export interface PacketContentResult {
  /** `null` when the stored snapshot is absent / an unsupported schema version (never a guess). */
  readonly content: PacketContentView | null;
  /** W-SUD-01: `true` iff redaction was applied for THIS caller on THIS read. */
  readonly appliedSudRedaction: boolean;
  /** The Part 2 banner text when `appliedSudRedaction`, else `null`. */
  readonly redactionNotice: string | null;
  /** Number of source entries elided (for the sampled server-side audit log ONLY — never put on the wire). */
  readonly redactedEntryCount: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every source id the snapshot's since-blocks + carry-forward hold (the fail-closed SUD elision set). */
export function allSnapshotSourceIds(snapshot: PacketSnapshot): ReadonlySet<string> {
  const s = snapshot.sinceLastIdg;
  return new Set<string>([
    ...s.encounters.map((e) => e.encounterId),
    ...s.significantAssessmentChanges.map((a) => a.assessmentId),
    ...s.j2051Triggers.map((h) => h.hopeAssessmentId),
    ...s.ordersChanged.map((o) => o.orderId),
    ...s.medicationsChanged.map((m) => m.medicationOrderId),
    ...s.flaggedEvents.map((f) => f.sourceId),
    ...snapshot.carryForwardActionItems.map((c) => c.actionItemId),
  ]);
}

const sinceBlockTotal = (s: PacketSnapshot["sinceLastIdg"]): number =>
  s.encounters.length +
  s.significantAssessmentChanges.length +
  s.j2051Triggers.length +
  s.ordersChanged.length +
  s.medicationsChanged.length +
  s.flaggedEvents.length;

/** Tolerate a jsonb block that is missing/not-an-array (legacy row) — empty, never a throw. */
const arr = <T>(v: unknown): readonly T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Normalise a stored snapshot to a fully-populated `PacketSnapshot` (null when unusable). */
function readSnapshot(raw: unknown): PacketSnapshot | null {
  if (!isObject(raw) || raw.schemaVersion !== SUPPORTED_PACKET_SCHEMA_VERSION) return null;
  if (!isObject(raw.meta) || !isObject(raw.patientCover) || !isObject(raw.carePlanSummary)) {
    return null;
  }
  const since = isObject(raw.sinceLastIdg) ? raw.sinceLastIdg : {};
  return {
    ...(raw as unknown as PacketSnapshot),
    sinceLastIdg: {
      encounters: arr(since.encounters),
      significantAssessmentChanges: arr(since.significantAssessmentChanges),
      j2051Triggers: arr(since.j2051Triggers),
      ordersChanged: arr(since.ordersChanged),
      medicationsChanged: arr(since.medicationsChanged),
      flaggedEvents: arr(since.flaggedEvents),
    },
    carryForwardActionItems: arr(raw.carryForwardActionItems),
    flagsForDiscussion: arr(raw.flagsForDiscussion),
    hopeContext: isObject(raw.hopeContext)
      ? (raw.hopeContext as PacketSnapshot["hopeContext"])
      : null,
    medicationHistory: isObject(raw.medicationHistory)
      ? (raw.medicationHistory as unknown as PacketSnapshot["medicationHistory"])
      : null,
  };
}

const NO_EXTERNAL_HISTORY_MESSAGE =
  "No external medication history available — clinician must collect history at bedside";
const EXTERNAL_HISTORY_NOT_PULLED_MESSAGE = "External medication history has not been pulled";

/** F-230 — project the snapshot's `medicationHistory` slot (see the `externalMedicationHistory` doc). */
export function externalMedicationHistoryView(
  mh: PacketSnapshot["medicationHistory"] | null,
  redact: boolean,
): PacketContentView["externalMedicationHistory"] {
  if (!mh) {
    return { captured: false, state: null, recordCount: null, lastPulledAt: null, message: null };
  }
  return {
    captured: true,
    state: mh.state,
    recordCount: redact ? null : mh.recordCount,
    lastPulledAt: mh.lastPulledAt,
    message:
      mh.state === "none_available"
        ? NO_EXTERNAL_HISTORY_MESSAGE
        : mh.state === "not_pulled"
          ? EXTERNAL_HISTORY_NOT_PULLED_MESSAGE
          : null,
  };
}

/** Whole-date `YYYY-MM-DD` of an ISO instant (UTC — deterministic; the summary never localises). */
const ymd = (iso: string): string => iso.slice(0, 10);

const LOC_LABEL: Record<PacketLevelOfCare, string> = {
  routine: "routine home care",
  continuous: "continuous home care",
  inpatient_respite: "inpatient respite care",
  general_inpatient: "general inpatient care",
};

const F2F_LABEL = {
  not_due: "not due",
  window_open: "window open",
  overdue: "overdue",
} as const;

const FLAG_LABEL: Record<string, string> = {
  level_of_care_candidate: "level-of-care candidate",
  recert_due: "recert due",
  complex_symptoms: "complex symptoms",
  family_meeting_needed: "family meeting needed",
  sud_pattern_review: "SUD pattern review",
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The deterministic Layer-1 cover text. Pure function of the (already-redacted) snapshot: same input ⇒ same
 * bytes. States absences explicitly ("none recorded") so an empty packet reads as an empty packet.
 */
export function composeCoverSummary(snapshot: PacketSnapshot, redacted: boolean): string {
  const c = snapshot.patientCover;
  const s = snapshot.sinceLastIdg;
  const sentences: string[] = [];

  sentences.push(
    `Age ${c.age}, ${LOC_LABEL[c.levelOfCare] ?? c.levelOfCare}, day ${c.daysOnService} on service. ` +
      `Primary diagnosis: ${c.primaryDiagnosisLabel.replace(/[.\s]+$/, "")} (${c.primaryDiagnosisIcd10}).`,
  );

  const sinceLabel =
    snapshot.meta.sinceContext === "first_idg"
      ? `admission (${ymd(snapshot.meta.sinceCursorIso)})`
      : `the last IDG (${ymd(snapshot.meta.sinceCursorIso)})`;
  const changes: string[] = [];
  if (s.encounters.length) changes.push(plural(s.encounters.length, "signed encounter"));
  if (s.significantAssessmentChanges.length)
    changes.push(plural(s.significantAssessmentChanges.length, "significant assessment change"));
  if (s.j2051Triggers.length)
    changes.push(plural(s.j2051Triggers.length, "HOPE symptom-impact trigger"));
  if (s.ordersChanged.length) changes.push(plural(s.ordersChanged.length, "order change"));
  if (s.medicationsChanged.length)
    changes.push(plural(s.medicationsChanged.length, "medication change"));
  if (s.flaggedEvents.length) changes.push(plural(s.flaggedEvents.length, "flagged event"));
  sentences.push(
    redacted
      ? // Under W-SUD-01 the blocks were elided for this caller — never claim "none recorded".
        `Since ${sinceLabel}: activity details are withheld.`
      : changes.length
        ? `Since ${sinceLabel}: ${changes.join(", ")}.`
        : `Since ${sinceLabel}: no signed encounters, assessment changes, order or medication changes, or flagged events recorded.`,
  );

  const recert =
    c.nextRecertDueAt !== null
      ? `Next recertification due ${ymd(c.nextRecertDueAt)}`
      : "Next recertification date not captured";
  sentences.push(
    c.f2fWindowState !== null
      ? `${recert}; face-to-face window ${F2F_LABEL[c.f2fWindowState]}.`
      : `${recert}.`,
  );

  const cp = snapshot.carePlanSummary;
  sentences.push(
    `Care plan: ${plural(cp.activeProblemCount, "active problem")}, ${plural(cp.activeGoalCount, "active goal")}, ` +
      `${plural(cp.activeInterventionCount, "active intervention")}; last signed ${ymd(cp.lastSignedAt)}, ` +
      `next review due ${ymd(cp.nextReviewDueAt)}${cp.isReviewOverdue ? " (overdue)" : ""}.`,
  );

  if (snapshot.carryForwardActionItems.length) {
    sentences.push(
      `${plural(snapshot.carryForwardActionItems.length, "carried-forward action item")} open.`,
    );
  }
  sentences.push(
    snapshot.flagsForDiscussion.length
      ? `Discussion flags: ${snapshot.flagsForDiscussion
          .map((f) => FLAG_LABEL[f.kind] ?? f.kind)
          .join(", ")}.`
      : "No discussion flags.",
  );
  if (redacted) sentences.push(`${SUD_REDACTION_NOTICE}.`);
  return sentences.join(" ");
}

const disciplineOneLiner = (
  discipline: DisciplineKey,
  count: number,
  sinceContext: "prior_idg" | "first_idg",
): string =>
  `${count} highlighted item(s) for ${discipline} since ${
    sinceContext === "prior_idg" ? "the last IDG" : "admission"
  }`;

/**
 * Map one stored packet row to the content read model for ONE caller.
 *
 * @param sudDisclosureAllowed whether THIS caller may see Part 2 content for the patient. Resolved lazily by the
 *   service (M39 `evaluateForInternalAccess`, fail-closed) and only consulted when the snapshot's patient is
 *   SUD-flagged — pass a thunk so a non-SUD packet costs no consent round-trip.
 */
export async function mapPacketContent(
  source: PacketContentSource,
  sudDisclosureAllowed: () => Promise<boolean>,
): Promise<PacketContentResult> {
  const snapshot = readSnapshot(source.builtSnapshot);
  if (snapshot === null) {
    return {
      content: null,
      appliedSudRedaction: false,
      redactionNotice: null,
      redactedEntryCount: 0,
    };
  }

  const viewsRaw = isObject(source.disciplineViews) ? source.disciplineViews : {};
  const disciplineKeys = Object.keys(DISCIPLINE_VIEW_POLICY) as DisciplineKey[];
  const views = {} as Record<DisciplineKey, DisciplineViewBlock>;
  for (const key of disciplineKeys) {
    const v = isObject(viewsRaw[key]) ? (viewsRaw[key] as Partial<DisciplineViewBlock>) : {};
    views[key] = {
      oneLineSummary: typeof v.oneLineSummary === "string" ? v.oneLineSummary : "",
      highlightedEntries: arr(v.highlightedEntries),
      openQuestions: arr(v.openQuestions),
      layer2Polished: null, // never surfaced — Layer 1 only
    };
  }

  // W-SUD-01 — the consent round-trip happens only for a SUD-flagged patient; an outage denies (fail-closed).
  let redact = false;
  if (snapshot.patientCover.activeSudFlag) {
    let allowed = false;
    try {
      allowed = await sudDisclosureAllowed();
    } catch {
      allowed = false;
    }
    redact = !allowed;
  }

  const before = sinceBlockTotal(snapshot.sinceLastIdg);
  const built = applySudRedaction(
    { snapshot, disciplineViews: views },
    { hasPart2Release: !redact, sudFlaggedSourceIds: allSnapshotSourceIds(snapshot) },
  );
  const snap = built.snapshot;
  const s = snap.sinceLastIdg;
  const redactedEntryCount = redact ? before - sinceBlockTotal(s) : 0;

  const disciplines: PacketContentDiscipline[] = disciplineKeys.map((discipline) => {
    const view = built.disciplineViews[discipline];
    return {
      discipline,
      oneLineSummary: redact
        ? disciplineOneLiner(discipline, view.highlightedEntries.length, snap.meta.sinceContext)
        : view.oneLineSummary ||
          disciplineOneLiner(discipline, view.highlightedEntries.length, snap.meta.sinceContext),
      items: view.highlightedEntries.map((e) => ({
        sourceKind: e.sourceKind,
        sourceId: e.sourceId,
        label: e.label,
        summary: e.summary,
        severity: e.severity ?? null,
      })),
      openQuestions: view.openQuestions,
    };
  });

  // The cover flags `level_of_care_candidate` / `complex_symptoms` were DERIVED at build from the very since-blocks
  // just elided; showing them would disclose that (possibly SUD-related) activity exists. Drop them under redaction
  // (fail-closed); recert / family-meeting / SUD-pattern flags derive from cover facts, not source blocks.
  const SOURCE_DERIVED_FLAGS = new Set(["level_of_care_candidate", "complex_symptoms"]);
  const flags = redact
    ? snap.flagsForDiscussion.filter((f) => !SOURCE_DERIVED_FLAGS.has(f.kind))
    : snap.flagsForDiscussion;
  const shown: PacketSnapshot = { ...snap, flagsForDiscussion: flags };

  const c = snap.patientCover;
  const counts: PacketContentCounts = {
    signedEncounters: s.encounters.length,
    assessmentChanges: s.significantAssessmentChanges.length,
    hopeTriggers: s.j2051Triggers.length,
    orderChanges: s.ordersChanged.length,
    medicationChanges: s.medicationsChanged.length,
    flaggedEvents: s.flaggedEvents.length,
    carryForwardActionItems: snap.carryForwardActionItems.length,
  };

  const content: PacketContentView = {
    schemaVersion: SUPPORTED_PACKET_SCHEMA_VERSION,
    cover: {
      summary: composeCoverSummary(shown, redact),
      builtAt: snap.meta.builtAt,
      sinceCursorAt: snap.meta.sinceCursorIso,
      sinceContext: snap.meta.sinceContext,
      nameAtBuild: c.fullNameRedacted,
      age: c.age,
      primaryDiagnosisIcd10: c.primaryDiagnosisIcd10,
      primaryDiagnosisLabel: c.primaryDiagnosisLabel,
      levelOfCare: c.levelOfCare,
      daysOnService: c.daysOnService,
      hasActiveDpoa: c.activeDpoa !== null && c.activeDpoa !== undefined,
      activeSudFlag: c.activeSudFlag,
      recert: {
        nextRecertDueAt: c.nextRecertDueAt ?? null,
        f2fWindowState: c.f2fWindowState ?? null,
      },
      carePlan: {
        activeProblemCount: snap.carePlanSummary.activeProblemCount,
        activeGoalCount: snap.carePlanSummary.activeGoalCount,
        activeInterventionCount: snap.carePlanSummary.activeInterventionCount,
        lastSignedAt: snap.carePlanSummary.lastSignedAt,
        nextReviewDueAt: snap.carePlanSummary.nextReviewDueAt,
        isReviewOverdue: snap.carePlanSummary.isReviewOverdue,
      },
      discussionFlags: flags.map((f) => ({ kind: f.kind, detail: f.detail })),
      counts,
    },
    disciplines,
    signedEncounters: s.encounters.map((e) => ({
      encounterId: e.encounterId,
      encounterType: e.encounterType,
      discipline: e.authorDiscipline,
      signedAt: e.signedAt,
    })),
    assessmentChanges: s.significantAssessmentChanges.map((a) => ({
      assessmentId: a.assessmentId,
      scaleKind: a.scaleKind,
      changeKind: a.changeKind,
      occurredAt: a.occurredAt,
    })),
    hopeTimepoints: {
      captured: snap.hopeContext !== null,
      upcoming: (snap.hopeContext?.upcomingTimepoints ?? []).map((t) => ({
        timepoint: t.timepoint,
        dueAt: t.dueAt,
      })),
      // Under W-SUD-01 the count (derived from the elided J2051 triggers) is withheld — "not available".
      openSfvCount: redact ? null : (snap.hopeContext?.openSfvCount ?? null),
      symptomImpactTriggers: s.j2051Triggers.map((h) => ({
        hopeAssessmentId: h.hopeAssessmentId,
        triggerKind: h.triggerKind,
        firedAt: h.firedAt,
      })),
    },
    externalMedicationHistory: externalMedicationHistoryView(snap.medicationHistory ?? null, redact),
    orderChanges: s.ordersChanged.map((o) => ({
      orderId: o.orderId,
      orderKind: o.orderKind,
      changeKind: o.changeKind,
      changedAt: o.changedAt,
    })),
    medicationChanges: s.medicationsChanged.map((m) => ({
      medicationOrderId: m.medicationOrderId,
      drugLabel: m.drugLabel,
      changeKind: m.changeKind,
      changedAt: m.changedAt,
    })),
    flaggedEvents: s.flaggedEvents.map((f) => ({
      kind: f.kind,
      sourceId: f.sourceId,
      occurredAt: f.occurredAt,
      severity: f.severity,
    })),
    carryForwardActionItems: snap.carryForwardActionItems.map((a) => ({
      actionItemId: a.actionItemId,
      assignedToMembershipId: a.assignedToMembershipId,
      dueDate: a.dueDate,
      carryForwardCount: a.carryForwardCount,
    })),
  };

  return {
    content,
    appliedSudRedaction: redact,
    redactionNotice: redact ? SUD_REDACTION_NOTICE : null,
    redactedEntryCount,
  };
}
