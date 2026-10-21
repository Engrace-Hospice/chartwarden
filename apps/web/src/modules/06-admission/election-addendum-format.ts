// apps/web/src/modules/06-admission/election-addendum-format.ts — pure labels / tones / countdown for the
// election statement addendum panel (42 CFR 418.24(c)/(d)). No React, unit-testable.
import type { StatusTone } from "@wardenx/ui";
import type {
  AddendumOverview,
  AddendumStatus,
  AddendumVersion,
  ItemCategory,
} from "./election-addendum-api";

export const ADDENDUM_STATUS_LABEL: Record<AddendumStatus, string> = {
  draft: "Draft",
  furnished: "Furnished — awaiting signature",
  signed: "Signed",
  refused: "Refused — reason documented",
  signature_not_required: "Signature not required",
  not_required: "Not required",
};

export const ADDENDUM_STATUS_TONE: Record<AddendumStatus, StatusTone> = {
  draft: "progress",
  furnished: "warning",
  signed: "success",
  refused: "neutral",
  signature_not_required: "neutral",
  not_required: "neutral",
};

export const CATEGORY_LABEL: Record<ItemCategory, string> = {
  condition: "Condition",
  item: "Item",
  service: "Service",
  drug: "Drug",
};

export const CATEGORY_OPTIONS = (Object.keys(CATEGORY_LABEL) as ItemCategory[]).map((value) => ({
  value,
  label: CATEGORY_LABEL[value],
}));

export const EXEMPTION_OPTIONS = [
  { value: "death", label: "The patient died" },
  { value: "revocation", label: "The patient revoked the election" },
  { value: "discharge", label: "The patient was discharged" },
] as const;

export const FURNISH_OPTIONS = [
  { value: "paper", label: "Paper copy handed over" },
  { value: "electronic_with_paper_copy", label: "Electronic, with a paper copy" },
] as const;

/** The compliance-window labels (also used by the compliance dashboard). */
export const ADDENDUM_WINDOW_LABEL: Record<string, string> = {
  election_addendum_initial: "Election addendum (5 days)",
  election_addendum_update: "Addendum update (3 days)",
};

/** A bare `YYYY-MM-DD` is a calendar date: parse it on the local calendar (`new Date("2026-10-07")` is UTC
 *  midnight, which is the previous day anywhere west of Greenwich). A timestamp parses as an instant. */
function calendarDate(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
}

/** Whole calendar days from `now` to `dueAt` (negative = overdue), on the viewer's local calendar. */
export function daysUntil(dueAt: string, now: Date = new Date()): number {
  const due = calendarDate(dueAt);
  const a = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / 86_400_000);
}

/** "Due in 3 days" / "Due today" / "Overdue by 2 days". */
export function countdownLabel(dueAt: string, now: Date = new Date()): string {
  const d = daysUntil(dueAt, now);
  if (d === 0) return "Due today";
  if (d > 0) return `Due in ${d} day${d === 1 ? "" : "s"}`;
  return `Overdue by ${-d} day${d === -1 ? "" : "s"}`;
}

export function countdownTone(dueAt: string, now: Date = new Date()): StatusTone {
  const d = daysUntil(dueAt, now);
  return d < 0 ? "error" : d <= 1 ? "warning" : "progress";
}

/** The earliest open 418.24(d) window, if any. */
export function nextDue(ov: AddendumOverview): { kind: string; dueAt: string } | null {
  const open = [...ov.openWindows].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return open[0] ?? null;
}

export function usDate(value?: string | null): string {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  if (value.length === 10) return `${m[2]}/${m[3]}/${m[1]}`;
  const d = new Date(value);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

/** Minimum refusal-reason length the server enforces. */
export const REFUSAL_MIN = 5;

// ── scanned signed paper copy (418.24(c)(9)) ────────────────────────────────────────────────────────

/** A date input's `YYYY-MM-DD` as the instant of LOCAL midnight — never in the future for today's date. */
export function localDateToIso(value: string): string {
  return calendarDate(value).toISOString();
}

/** Today on the viewer's local calendar, as a date input value. */
export function todayInput(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** How the acknowledgement was captured, for the drawer and the panel ("Signed — scanned paper copy"). */
export function acknowledgementLabel(
  v: Pick<AddendumVersion, "status" | "acknowledgementSource" | "contentSource">,
): string | null {
  if (v.status !== "signed" && v.status !== "refused") return null;
  const outcome = v.status === "signed" ? "Signed" : "Refused";
  if (v.acknowledgementSource === "uploaded") {
    return v.contentSource === "scanned_paper"
      ? `${outcome} — scanned paper copy (content on paper)`
      : `${outcome} — scanned paper copy`;
  }
  if (v.acknowledgementSource === "structured") return `${outcome} — recorded in ChartWarden`;
  return outcome;
}

/** What the paper copy form needs before it can upload. */
export interface ScannedCopyDraft {
  readonly file: File | null;
  readonly outcome: "signed" | "refused";
  readonly signerKind: "beneficiary" | "representative";
  readonly representativeName: string;
  readonly paperDate: string;
  readonly furnishedDate: string;
  readonly reason: string;
  /** True when the version was never furnished in WardenX (a draft). */
  readonly needsFurnishDate: boolean;
}

/** The first problem with the paper-copy form (mirrors the server's guards), or null when it can upload. */
export function scannedCopyProblem(
  d: ScannedCopyDraft,
  today: string = todayInput(),
): string | null {
  if (!d.file) return "Choose the scanned paper copy to upload.";
  if (d.outcome === "signed" && d.signerKind === "representative" && !d.representativeName.trim()) {
    return "A representative signature must name the representative.";
  }
  if (d.outcome === "refused" && d.reason.trim().length < REFUSAL_MIN) {
    return `Document why the addendum was not signed (at least ${REFUSAL_MIN} characters).`;
  }
  if (!d.paperDate) {
    return d.outcome === "signed" ? "Enter the signature date." : "Enter the date of the refusal.";
  }
  if (d.paperDate > today) return "The date on the paper copy cannot be in the future.";
  if (d.needsFurnishDate) {
    if (!d.furnishedDate) return "Enter the date the paper addendum was given to the patient.";
    if (d.furnishedDate > d.paperDate) {
      return "The addendum must have been furnished on or before the date on the paper copy.";
    }
  }
  return null;
}

/** The (c) elements a draft still lacks (mirrors the server's completeness check, `addendumContentGaps`). */
export function draftContentGaps(
  v: Pick<
    AddendumVersion,
    | "hospiceName"
    | "patientName"
    | "medicalRecordNumber"
    | "terminalDiagnosis"
    | "items"
    | "noNonCoveredItems"
    | "clinicalExplanation"
  >,
): string[] {
  const blank = (x: string | null | undefined) => (x ?? "").trim().length === 0;
  const gaps: string[] = [];
  if (blank(v.hospiceName)) gaps.push("hospice name");
  if (blank(v.patientName)) gaps.push("patient name");
  if (blank(v.medicalRecordNumber)) gaps.push("medical record number");
  if (v.terminalDiagnosis.length === 0) gaps.push("terminal diagnosis");
  if (v.items.length === 0 && !v.noNonCoveredItems) {
    gaps.push("the non-covered items, or that there are none");
  }
  if (v.items.length > 0 && blank(v.clinicalExplanation)) gaps.push("clinical explanation");
  if (v.items.some((i) => blank(i.description) || blank(i.reasonNotCovered))) {
    gaps.push("a description and reason for every item");
  }
  return gaps;
}
