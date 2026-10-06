// apps/web/src/modules/06-admission/election-addendum-format.ts — pure labels / tones / countdown for the
// election statement addendum panel (42 CFR 418.24(c)/(d)). No React, unit-testable.
import type { StatusTone } from "@wardenx/ui";
import type { AddendumOverview, AddendumStatus, ItemCategory } from "./election-addendum-api";

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

/** Whole calendar days from `now` to `dueAt` (negative = overdue), on the viewer's local calendar. */
export function daysUntil(dueAt: string, now: Date = new Date()): number {
  const due = new Date(dueAt);
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
