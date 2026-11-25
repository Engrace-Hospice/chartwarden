// apps/web/src/modules/08-encounters/compose — what the visit-note composer page holds besides React: the names of the template sections it
// treats specially, the parts of the note that keep their own form, and the pure helpers and notices that go with them (moved out of
// encounter-compose.tsx unchanged).
import type { PanelStatus } from "../../../shell/panel-status";
import type { UiFeedback } from "../compose-feedback";
import {
  type DraftSections,
  type TemplateView,
  isSectionPopulated,
  sectionHasEmptySlots,
  toSelectionsBody,
} from "../encounters-api";
import type { RecordedPanelKind } from "../recorded-panels";

export interface PatientSummary {
  readonly firstName: string;
  readonly lastName: string;
  readonly mrn: string;
  readonly dob?: string;
}

const SHELL_EXIT_PATHS = new Set(["/expired", "/error", "/maintenance", "/tenant-unavailable"]);
export const isShellExit = (pathname: string): boolean =>
  SHELL_EXIT_PATHS.has(pathname) || pathname === "/login" || pathname.startsWith("/login/");

export const serializedDraft = (draft: DraftSections, fallIncidentId: string | null): string =>
  JSON.stringify(toSelectionsBody(draft, fallIncidentId));

/** The parts of the note that keep their own form and say so (see `useReportPanelStatus`). */
export type PanelKey = RecordedPanelKind | "vitals" | "plan";
export type PanelStatuses = Readonly<Partial<Record<PanelKey, PanelStatus>>>;

/** The note's own words for a part of it that keeps its own form (named in the notice that asks the author to save or discard it). */
export const PANEL_ORDER: readonly PanelKey[] = ["adl", "nutrition", "wounds", "vitals", "plan"];

export function unsavedPanelsFeedback(titles: readonly string[]): UiFeedback {
  return {
    tone: "warning",
    title: "Unsaved entries in a section",
    message: `Save or discard the unsaved entries in ${titles.join(", ")} before finalizing.`,
    tag: "findings-unsaved",
  };
}

/** What was taken out of a stored draft because the template cannot show it and the server would refuse it. */
export function removedFromDraftFeedback(statements: number, details: number): UiFeedback {
  const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
  const parts = [
    statements > 0
      ? `${statements} saved ${plural(statements, "statement is", "statements are")} no longer offered in ${plural(statements, "its", "their")} section and ${plural(statements, "was", "were")} removed here.`
      : null,
    details > 0
      ? `${details} saved ${plural(details, "detail does", "details do")} not belong to ${plural(details, "its", "their")} statement and ${plural(details, "was", "were")} removed here.`
      : null,
  ].filter((part): part is string => part !== null);
  return {
    tone: "warning",
    title:
      statements > 0 ? "Statements removed from this draft" : "Details removed from this draft",
    message: `${parts.join(" ")} Save the draft to apply the change.`,
  };
}

/** The template section a visit reason is recorded in. */
export const REASON_SECTION_ID = "chief_concern";

/** The template section that states the visit's recorded vitals: the vitals form lives inside it, so a required "Vital Signs Review" shows where to enter them. */
export const VITALS_SECTION_ID = "vitals_review";

/** The template section that states the plan and the next visit: it carries the schedule and the structured plan-entry fields. */
export const PLAN_SECTION_ID = "plan";

/**
 * The recorded panels whose saved record the draft compiler states (`describeRecordedAdl`, for the aide's `adl` section); the others are not.
 * Keyed by panel, not by template: on a note whose template drafts nothing from the ADLs the re-read is harmless (it reads no source).
 * Keep it in step with the compiler (a drift note sits beside `describeRecordedAdl` in `compile.ts`).
 */
export const DRAFT_SOURCE_PANELS: ReadonlySet<RecordedPanelKind> = new Set<RecordedPanelKind>([
  "adl",
]);

/** What the composer is doing to the note right now (the buttons wait while it does). */
export type ComposeOperation = "saving" | "finalizing";

/** The reason the scheduled visit's purpose suggested, held as an UNSAVED choice until the clinician saves it. */
export interface ReasonSuggestion {
  readonly code: string;
  readonly from: string;
}

export interface ComposeCompletion {
  readonly completed: number;
  readonly total: number;
  readonly requiredRemaining: number;
  readonly percent: number;
}

/** How much of the template is documented (by the author or by a saved record), and how many required sections are still open. */
export function documentationCompletion(
  template: TemplateView | null,
  draft: DraftSections,
  filledByRecord: ReadonlySet<string>,
  confirmedIds: ReadonlySet<string>,
  requiredRemaining: number,
): ComposeCompletion {
  if (!template) {
    return {
      completed: 0,
      total: 0,
      requiredRemaining: 0,
      percent: 0,
    };
  }

  const completed = template.sections.filter(
    (section) =>
      (isSectionPopulated(draft, section.sectionId, confirmedIds) ||
        filledByRecord.has(section.sectionId)) &&
      !sectionHasEmptySlots(template, draft, section.sectionId),
  ).length;

  const total = template.sections.length;

  return {
    completed,
    total,
    requiredRemaining,
    percent: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}
