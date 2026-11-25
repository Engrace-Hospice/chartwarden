// apps/web/src/modules/08-encounters — the pure rules behind the visit-note draft screens (ADR-0114). No I/O, no clock: the words a
// clinician reads for each section state, which sections still need them, how the server's refusals read, and the score trend. The
// server decides every state; this only names it.
import type { EsasrItemScores } from "@chartwarden/types";
import type { StatusTone } from "@chartwarden/ui";
import type {
  DraftOrigin,
  DraftSectionState,
  DraftSectionView,
  DraftView,
  Resolution,
} from "./draft-api";

/**
 * What a screen knows of one draft: not yet read, off for this viewer (switch off or no access), unreadable, or the draft itself. An
 * amending addendum's draft is its author's alone (403 for anyone else): `notAuthor`, which only an addendum's read can be.
 */
export type DraftLoad =
  | { readonly status: "loading" }
  | { readonly status: "off" }
  | { readonly status: "notAuthor" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly draft: DraftView };

export const STATE_LABEL: Readonly<Record<DraftSectionState, string>> = {
  not_drafted: "Nothing to draft",
  unresolved: "Needs your review",
  confirmed: "Confirmed",
  deselected: "Deselected",
  needs_reconfirmation: "Changed, review again",
};

export const STATE_TONE: Readonly<Record<DraftSectionState, StatusTone>> = {
  not_drafted: "neutral",
  unresolved: "progress",
  confirmed: "success",
  deselected: "neutral",
  needs_reconfirmation: "warning",
};

/** What each kind of source reads as: "where it came from" (VN-D5). The ids are never on the wire (VN-D7). */
export const ORIGIN_LABEL: Readonly<Record<DraftOrigin, string>> = {
  care_plan_goal: "care plan goals",
  care_plan_intervention: "care plan interventions",
  scale_reading: "scale readings (PPS, ESAS-r) and their change",
  vitals: "vitals recorded at this visit",
  medication_change: "medication and order changes since the last visit",
  // S2 (recertification and face-to-face visits):
  weight_reading: "weight readings across the benefit period",
  benefit_period: "the benefit period (and its level of care on the visit date, when one applies)",
  face_to_face: "the face-to-face encounter's recorded facts",
  certification: "the signed certification of terminal illness",
  // S2b (RN admission visit):
  medication_order: "the medication orders in effect at the visit",
  caregiver: "the caregivers on record on the visit date",
  advance_directive_acknowledgment: "the advance directive acknowledgment on file at the visit",
  // S3 (aide visit): the ADLs the aide recorded for this visit lead the section.
  recorded_adl: "the activities of daily living recorded at this visit",
  // S4 (social-work and chaplain visits): the goals and interventions of the discipline's own plan, as signed at the visit time. Not the care
  // plan's elements, so a confirmation links nothing of the care plan (`touchesCarePlan` stays false); since S4b it keeps the discipline's own
  // elements instead (`touchesDisciplinePlan`).
  discipline_plan_goal: "the goals of the discipline's plan of care at the visit",
  discipline_plan_intervention: "the interventions of the discipline's plan of care at the visit",
  // S5b (IDG follow-up visits): the one IDG action item the author linked the visit to (its meeting date, decision kind and due date; never its title or body).
  idg_action_item:
    "the IDG action item this visit follows up (the team's decision and its due date)",
};

export function originsText(origins: readonly DraftOrigin[]): string {
  return origins.map((origin) => ORIGIN_LABEL[origin]).join("; ");
}

const CARE_PLAN_ORIGINS: readonly DraftOrigin[] = ["care_plan_goal", "care_plan_intervention"];

const isKnownState = (value: unknown): value is DraftSectionState =>
  typeof value === "string" && Object.hasOwn(STATE_LABEL, value);
const isKnownOrigin = (value: unknown): value is DraftOrigin =>
  typeof value === "string" && Object.hasOwn(ORIGIN_LABEL, value);

/**
 * Whether `value` is a section the screens can render: a section id, a state with a label, and origins that each read as words. A draft
 * with any other section is a broken answer (the load says "unavailable"), never a half-rendered section ("Built from undefined.").
 */
export function isDraftSectionView(value: unknown): value is DraftSectionView {
  if (value === null || typeof value !== "object") return false;
  const { sectionId, state, origins } = value as Record<string, unknown>;
  return (
    typeof sectionId === "string" &&
    isKnownState(state) &&
    Array.isArray(origins) &&
    origins.every(isKnownOrigin)
  );
}

export const touchesCarePlan = (section: Pick<DraftSectionView, "origins">): boolean =>
  section.origins.some((origin) => CARE_PLAN_ORIGINS.includes(origin));

const DISCIPLINE_PLAN_ORIGINS: readonly DraftOrigin[] = [
  "discipline_plan_goal",
  "discipline_plan_intervention",
];

/**
 * Whether a section of the draft is built from the discipline's own plan (S4: the social-work and chaplain visits). Confirming such a section
 * links nothing of the CARE PLAN to the visit (it keeps the discipline's own elements, S4b), so the care-plan panel must not say that a confirmation links its items.
 */
export const draftsFromDisciplinePlan = (draft: Pick<DraftView, "sections">): boolean =>
  draft.sections.some(touchesDisciplinePlan);

/**
 * The disciplines whose notes are drafted from their own plan (a social worker's and a chaplain's). The server decides per template (a visit of such a
 * discipline that is not drafted from the plan answers the plan list 422 and the picker then shows nothing); this only keeps every other discipline
 * from asking. Unlike `draftsFromDisciplinePlan` it holds when every item has been left out and the draft's own sections name no origin.
 */
export const isDisciplinePlanVisit = (discipline: string): boolean =>
  discipline === "msw" || discipline === "chaplain";

/**
 * An IDG follow-up visit (S5b), of any discipline: the one visit whose note drafts a section from an IDG action item the author links. The server decides
 * (any other visit answers the item list 422); this only keeps every other visit from asking, and holds whatever the draft's sections name.
 */
export const isIdgFollowUpVisit = (encounterType: string): boolean =>
  encounterType === "idg_followup";

/**
 * Whether a section of a social-work or chaplain template is the one the discipline's plan feeds (the server's source map, S4: a social worker's
 * `interventions` and `plan`, a chaplain's `plan`). An empty one may be a section whose items were left out; any other (a chief concern, a psychosocial
 * or spiritual assessment) has no plan items to keep, so it says the record holds nothing like every other section.
 */
export function isDisciplinePlanSection(discipline: string, sectionId: string): boolean {
  if (discipline === "msw") return sectionId === "interventions" || sectionId === "plan";
  return discipline === "chaplain" && sectionId === "plan";
}

/** What the panel of a discipline's own plan is called: not the care plan's "Care plan for this visit", which a social worker or chaplain also sees. */
export const disciplinePlanTitle = (discipline: string): string =>
  discipline === "chaplain"
    ? "Spiritual care plan for this visit"
    : "Social work plan for this visit";

/**
 * Whether a section is built from the discipline's own plan (S4b): confirming it keeps its goals and interventions in this visit's statement of the
 * plan and deselecting it leaves them out, so the plan list reads again after either. Not the care plan's elements (`touchesCarePlan`).
 */
export function touchesDisciplinePlan(section: Pick<DraftSectionView, "origins">): boolean {
  return section.origins.some((origin) => DISCIPLINE_PLAN_ORIGINS.includes(origin));
}

export const isDrafted = (section: Pick<DraftSectionView, "state">): boolean =>
  section.state !== "not_drafted";

export const needsReview = (section: Pick<DraftSectionView, "state">): boolean =>
  section.state === "unresolved" || section.state === "needs_reconfirmation";

/** The draft is worth showing only when at least one section was drafted; otherwise the composer is exactly as it was. */
export const draftIsActive = (draft: DraftView | null): draft is DraftView =>
  draft?.sections.some(isDrafted) === true;

/**
 * The sections whose drafted text the clinician confirmed, as the draft says it now (`needs_reconfirmation` is not confirmed: the text
 * changed). A confirmed section is the text the note will read, so it populates a required section, as in the server's gate check 1.
 */
export function confirmedSectionIds(draft: DraftView | null): ReadonlySet<string> {
  return new Set(
    (draft?.sections ?? [])
      .filter((section) => section.state === "confirmed")
      .map((section) => section.sectionId),
  );
}

/** The state of the section's drafted text, or undefined when nothing was drafted for it (a section with no draft shows no draft line). */
export function draftedStateOf(
  draft: DraftView | null,
  sectionId: string,
): DraftSectionView["state"] | undefined {
  return draft?.sections.find(
    (candidate) => candidate.sectionId === sectionId && candidate.state !== "not_drafted",
  )?.state;
}

export interface ReviewCounts {
  readonly drafted: number;
  readonly resolved: number;
  readonly needReview: readonly DraftSectionView[];
}

export function reviewCounts(draft: DraftView): ReviewCounts {
  const drafted = draft.sections.filter(isDrafted);
  const needReview = drafted.filter(needsReview);
  return { drafted: drafted.length, resolved: drafted.length - needReview.length, needReview };
}

/** A copy of `draft` with `next` in place of the section of the same id. */
export function replaceSection(draft: DraftView, next: DraftSectionView): DraftView {
  return {
    ...draft,
    sections: draft.sections.map((section) =>
      section.sectionId === next.sectionId ? next : section,
    ),
  };
}

// ── the server's refusals, per section ─────────────────────────────────────────────────────────────────

export type IssueReason = "unresolved" | "stale";

export interface DraftIssue {
  readonly sectionId: string;
  readonly reason: IssueReason;
}

const ISSUE_REASON: Readonly<Record<string, IssueReason>> = {
  DRAFT_SECTION_UNRESOLVED: "unresolved",
  DRAFT_SECTION_STALE: "stale",
};

/**
 * The drafted sections a finalize 422 (`COMPLIANCE_GATE_FAILED`) or a sign 409 (`DRAFT_SECTION_STALE`) names. Both carry the envelope's
 * `details: [{ field: <sectionId>, code, message }]`; any other detail (a required section, a vital) is not about the draft.
 */
export function draftIssuesFrom(details: unknown): readonly DraftIssue[] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((detail): DraftIssue[] => {
    if (detail === null || typeof detail !== "object") return [];
    const { field, code } = detail as { field?: unknown; code?: unknown };
    const reason = typeof code === "string" ? ISSUE_REASON[code] : undefined;
    return typeof field === "string" && reason ? [{ sectionId: field, reason }] : [];
  });
}

const ISSUE_WORDS: Readonly<Record<IssueReason, string>> = {
  unresolved: "not confirmed or deselected yet",
  stale: "changed since you resolved it",
};

export function describeIssues(
  issues: readonly DraftIssue[],
  headingOf: (sectionId: string) => string,
): string {
  return issues
    .map((issue) => `${headingOf(issue.sectionId)} (${ISSUE_WORDS[issue.reason]})`)
    .join(", ");
}

/** What a finalize 422 (`COMPLIANCE_GATE_FAILED`) says: the drafted sections it names, and every other detail the gate listed. */
export interface DraftGateRefusal {
  readonly issues: readonly DraftIssue[];
  readonly others: readonly unknown[];
}

/** The draft part of a finalize refusal, or null when the gate named no drafted section (the refusal is then not about the draft). */
export function draftGateRefusal(details: unknown): DraftGateRefusal | null {
  const issues = draftIssuesFrom(details);
  if (issues.length === 0) return null;
  const others = (Array.isArray(details) ? details : []).filter(
    (detail) => draftIssuesFrom([detail]).length === 0,
  );
  return { issues, others };
}

/** The section the IDG follow-up's linked action item feeds (S5b). */
const IDG_FOLLOWUP_SECTION = "idg_followup";
/** Why that section can go stale at sign and what ends it: the item it states is no longer one the author is handed (reassigned, closed by another hand, Part 2), and the link is the author's to change. */
const IDG_FOLLOWUP_STALE_HINT =
  "The IDG action item this visit follows up is no longer available to you: choose another item, or press Clear the follow-up item, in the IDG follow-up item panel beside the note, then confirm the section again.";

/** What the signer reads when the sign is refused 409 `DRAFT_SECTION_STALE`: the sections named (when it named any) and what to do. */
export function signStaleMessage(
  details: unknown,
  headingOf: (sectionId: string) => string,
): string {
  const issues = draftIssuesFrom(details);
  const named = issues.length > 0 ? `: ${describeIssues(issues, headingOf)}` : "";
  const idgHint = issues.some((issue) => issue.sectionId === IDG_FOLLOWUP_SECTION)
    ? ` ${IDG_FOLLOWUP_STALE_HINT}`
    : "";
  return `Some drafted sections need another look before this note can be signed${named}. Review them in the note editor, then sign again.${idgHint}`;
}

// ── what a resolve says back ───────────────────────────────────────────────────────────────────────────

export interface SectionNote {
  readonly tone: "success" | "info" | "warning" | "error";
  readonly text: string;
}

/**
 * What a confirm or deselect refused 403 FORBIDDEN says. The draft is the AUTHOR's act, a supervisor's included: the signer is who confirmed,
 * so nobody else may confirm a draft the author will sign. Nothing was recorded; the section is as it was.
 */
export function notAuthorRefusal(amending: boolean): string {
  return amending
    ? "Only the author of this addendum can confirm or deselect the sections it amends. Nothing was changed. Ask them to do it, or open your own addendum."
    : "Only the author of this note can confirm or deselect its drafted sections, because the author is who signs it. Nothing was changed. Ask the author to do it.";
}

export function resolutionNote(
  requested: Resolution,
  previous: DraftSectionView,
  next: DraftSectionView,
): SectionNote {
  if (requested === "confirmed") {
    return {
      tone: "success",
      text: "Section confirmed. The note will read exactly what you saw here.",
    };
  }
  const unlinked = touchesCarePlan(previous)
    ? " Its care-plan items were unlinked from this visit; link them again in the care-plan list if needed."
    : touchesDisciplinePlan(previous)
      ? " Its plan items were left out of this visit; keep them again in the plan list if needed."
      : "";
  if (next.state === "not_drafted") {
    return {
      tone: "info",
      text: `Section deselected. Nothing is left to draft in it.${unlinked}`,
    };
  }
  return {
    tone: "success",
    text: `Section deselected. The drafted text stays out of the note; your own selections and notes stay in.${unlinked}`,
  };
}

// ── the score trend ────────────────────────────────────────────────────────────────────────────────────

export interface ScorePoint {
  readonly capturedAt: string;
  readonly score: number | null;
  /** The nine item scores of an ESAS-r reading, when the server sent them (older records and other scales have none). */
  readonly itemScores?: EsasrItemScores;
}

export interface ScoredReading {
  readonly capturedAt: string;
  readonly score: number;
  readonly itemScores?: EsasrItemScores;
}

export interface ScoreTrend {
  readonly latest: ScoredReading | null;
  readonly previous: ScoredReading | null;
  /** Latest minus previous; null with fewer than two scored readings. */
  readonly change: number | null;
  /** Newest first. */
  readonly recent: readonly ScoredReading[];
}

const RECENT_READINGS = 4;

/** The scored readings up to `notAfter` (the visit time, when known), oldest to newest, then summarized. */
export function trendOf(points: readonly ScorePoint[], notAfter?: string): ScoreTrend {
  const ceiling = notAfter === undefined ? Number.POSITIVE_INFINITY : Date.parse(notAfter);
  const scored = points
    .flatMap((point): ScoredReading[] =>
      point.score !== null && Date.parse(point.capturedAt) <= ceiling
        ? [
            {
              capturedAt: point.capturedAt,
              score: point.score,
              ...(point.itemScores ? { itemScores: point.itemScores } : {}),
            },
          ]
        : [],
    )
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  const latest = scored.at(-1) ?? null;
  const previous = scored.at(-2) ?? null;
  return {
    latest,
    previous,
    change: latest && previous ? latest.score - previous.score : null,
    recent: scored.slice(-RECENT_READINGS).reverse(),
  };
}

const TREND_WINDOW_DAYS = 90;
const MS_PER_DAY = 86_400_000;

/**
 * The series window the trend reads: the 90 days up to the visit's service date (the route takes whole dates, end of day inclusive).
 * Null for a service date that is not a date: there is no window to ask for, and `toISOString` would throw.
 */
export function trendWindow(
  serviceDate: string,
): { readonly from: string; readonly to: string } | null {
  const to = serviceDate.slice(0, 10);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(end)) return null;
  return { from: new Date(end - TREND_WINDOW_DAYS * MS_PER_DAY).toISOString().slice(0, 10), to };
}

export function describeChange(change: number | null): string {
  if (change === null) return "first reading";
  if (change === 0) return "no change";
  return `${change > 0 ? "up" : "down"} ${Math.abs(change)}`;
}
